use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata, OpenOptions},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::SystemTime,
};
use tauri::State;
use unicode_normalization::UnicodeNormalization;

const MAX_PAGE_SIZE: usize = 256;
const MAX_READ_SIZE: usize = 1024 * 1024;
const RECOVERY_DIRECTORY: &str = ".vistta-sync-recovery";

#[derive(Default)]
pub struct DirectorySyncState {
    scans: Mutex<HashMap<String, ScanSpool>>,
    operations: Mutex<HashMap<String, Arc<AtomicBool>>>,
    writes: Mutex<HashMap<String, PendingWrite>>,
}

struct ScanSpool {
    _file: tempfile::NamedTempFile,
    reader: BufReader<File>,
    count: usize,
    next: usize,
}

struct PendingWrite {
    root: PathBuf,
    target: PathBuf,
    operation_directory: PathBuf,
    file: File,
    digest: Sha256,
    size: u64,
    expected: Option<FileFingerprint>,
    recoverable: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryManifest {
    id: String,
    target: String,
    created_at: i64,
    expected: Option<FileFingerprint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootCapabilities {
    root: String,
    directory_metadata: bool,
    scoped_selection: bool,
    persisted_grant: bool,
    streaming_read: bool,
    streaming_write: bool,
    hashing: bool,
    source_revalidation: bool,
    recoverable_replacement: bool,
    atomic_replacement: bool,
    durable_replacement: bool,
    cancellation: bool,
    foreground_lifecycle: bool,
    watch: bool,
    stable_identity: bool,
    supported: bool,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    size: u64,
    modified: Option<String>,
    identity: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    size: Option<u64>,
    modified: Option<String>,
    readonly: bool,
    identity: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStart {
    generation: String,
    count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanPage {
    generation: String,
    entries: Vec<ScanEntry>,
    count: usize,
    complete: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HashResult {
    sha256: String,
    fingerprint: FileFingerprint,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadChunk {
    data: String,
    offset: u64,
    next_offset: u64,
    complete: bool,
    fingerprint: FileFingerprint,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteStart {
    id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteProgress {
    id: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    id: String,
    sha256: String,
    size: u64,
    backup_retained: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryResult {
    repaired: Vec<String>,
    discarded: Vec<String>,
    ambiguous: Vec<String>,
}

#[tauri::command]
pub fn probe_root(root: String) -> Result<RootCapabilities, String> {
    let root = canonical_root(&root)?;
    Ok(RootCapabilities {
        root: root.to_string_lossy().into_owned(),
        directory_metadata: true,
        scoped_selection: true,
        persisted_grant: true,
        streaming_read: true,
        streaming_write: true,
        hashing: true,
        source_revalidation: true,
        recoverable_replacement: true,
        atomic_replacement: true,
        durable_replacement: true,
        cancellation: true,
        foreground_lifecycle: false,
        watch: true,
        stable_identity: cfg!(unix),
        supported: true,
    })
}

#[tauri::command]
pub async fn start_scan(
    state: State<'_, DirectorySyncState>,
    root: String,
    generation: String,
) -> Result<ScanStart, String> {
    if generation.is_empty() {
        return Err("Scan generation is required".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut operations = state.operations.lock().map_err(lock_error)?;
        if operations
            .insert(generation.clone(), cancelled.clone())
            .is_some()
        {
            return Err("Scan generation is already active".into());
        }
    }

    let root = canonical_root(&root)?;
    let result: Result<(usize, ScanSpool), String> = (|| {
        let mut spool = tempfile::NamedTempFile::new().map_err(io_error)?;
        let (count, first_digest) = {
            let mut writer = BufWriter::new(spool.as_file_mut());
            let result = scan_pass(&root, &cancelled, |entry| {
                serde_json::to_writer(&mut writer, &entry).map_err(|error| error.to_string())?;
                writer.write_all(b"\n").map_err(io_error)
            })?;
            writer.flush().map_err(io_error)?;
            result
        };
        let (verified_count, verified_digest) = scan_pass(&root, &cancelled, |_| Ok(()))?;
        if count != verified_count || first_digest != verified_digest {
            return Err("Directory changed during scan".into());
        }
        let reader = BufReader::new(spool.reopen().map_err(io_error)?);
        Ok((
            count,
            ScanSpool {
                _file: spool,
                reader,
                count,
                next: 0,
            },
        ))
    })();
    state
        .operations
        .lock()
        .map_err(lock_error)?
        .remove(&generation);
    let (count, spool) = result?;
    state
        .scans
        .lock()
        .map_err(lock_error)?
        .insert(generation.clone(), spool);
    Ok(ScanStart { generation, count })
}

#[tauri::command]
pub fn next_scan_page(
    state: State<'_, DirectorySyncState>,
    generation: String,
    after: usize,
    limit: usize,
) -> Result<ScanPage, String> {
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(format!(
            "Scan page size must be between 1 and {MAX_PAGE_SIZE}"
        ));
    }
    let mut scans = state.scans.lock().map_err(lock_error)?;
    let scan = scans
        .get_mut(&generation)
        .ok_or_else(|| "Scan generation is unavailable".to_string())?;
    if after != scan.next {
        return Err("Scan page cursor is invalid".into());
    }
    let mut page = Vec::with_capacity(limit.min(scan.count - scan.next));
    let mut line = String::new();
    while page.len() < limit && scan.next < scan.count {
        line.clear();
        if scan.reader.read_line(&mut line).map_err(io_error)? == 0 {
            return Err("Scan spool ended before its declared count".into());
        }
        page.push(serde_json::from_str(line.trim_end()).map_err(|error| error.to_string())?);
        scan.next += 1;
    }
    let end = scan.next;
    let complete = end == scan.count;
    if complete {
        scans.remove(&generation);
    }
    Ok(ScanPage {
        generation,
        entries: page,
        count: end,
        complete,
    })
}

#[tauri::command]
pub fn cancel_operation(
    state: State<'_, DirectorySyncState>,
    operation_id: String,
) -> Result<bool, String> {
    let operations = state.operations.lock().map_err(lock_error)?;
    if let Some(cancelled) = operations.get(&operation_id) {
        cancelled.store(true, Ordering::Release);
        return Ok(true);
    }
    drop(operations);
    Ok(state
        .scans
        .lock()
        .map_err(lock_error)?
        .remove(&operation_id)
        .is_some())
}

#[tauri::command]
pub fn begin_lease(operation_id: String) -> Result<bool, String> {
    require_operation_id(&operation_id)?;
    Ok(true)
}

#[tauri::command]
pub fn end_lease(operation_id: String) -> Result<bool, String> {
    require_operation_id(&operation_id)?;
    Ok(true)
}

#[tauri::command]
pub async fn hash_file(
    state: State<'_, DirectorySyncState>,
    root: String,
    relative_path: String,
    operation_id: String,
) -> Result<HashResult, String> {
    if operation_id.is_empty() {
        return Err("Hash operation id is required".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut operations = state.operations.lock().map_err(lock_error)?;
        if operations
            .insert(operation_id.clone(), cancelled.clone())
            .is_some()
        {
            return Err("Hash operation is already active".into());
        }
    }

    let result = hash_open_file(&canonical_root(&root)?, &relative_path, &cancelled);
    state
        .operations
        .lock()
        .map_err(lock_error)?
        .remove(&operation_id);
    result
}

#[tauri::command]
pub fn read_file_chunk(
    root: String,
    relative_path: String,
    offset: u64,
    limit: usize,
    expected: FileFingerprint,
) -> Result<ReadChunk, String> {
    if !(1..=MAX_READ_SIZE).contains(&limit) {
        return Err(format!("Read size must be between 1 and {MAX_READ_SIZE}"));
    }
    let root = canonical_root(&root)?;
    let path = resolve_existing(&root, &relative_path)?;
    let mut file = open_regular_file(&path)?;
    let before = fingerprint(&file.metadata().map_err(io_error)?)?;
    if before != expected || offset > before.size {
        return Err("File changed before read".into());
    }

    file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
    let mut data = vec![0; limit.min((before.size - offset) as usize)];
    file.read_exact(&mut data).map_err(io_error)?;
    let after = fingerprint(&file.metadata().map_err(io_error)?)?;
    if after != before {
        return Err("File changed during read".into());
    }
    let next_offset = offset + data.len() as u64;
    Ok(ReadChunk {
        data: BASE64.encode(data),
        offset,
        next_offset,
        complete: next_offset == before.size,
        fingerprint: before,
    })
}

#[tauri::command]
pub fn begin_write(
    state: State<'_, DirectorySyncState>,
    root: String,
    relative_path: String,
    expected: Option<FileFingerprint>,
) -> Result<WriteStart, String> {
    let root = canonical_root(&root)?;
    let (target, target_parent) = resolve_target(&root, &relative_path)?;
    assert_target_precondition(&target, expected.as_ref())?;

    let recovery_root = recovery_root(&root)?;
    let id = uuid::Uuid::new_v4().to_string();
    let operation_directory = recovery_root.join(&id);
    fs::create_dir(&operation_directory).map_err(io_error)?;
    sync_directory(&recovery_root)?;

    let manifest = RecoveryManifest {
        id: id.clone(),
        target: relative_path,
        created_at: Utc::now().timestamp_millis(),
        expected: expected.clone(),
    };
    write_durable(
        &operation_directory.join("manifest.json"),
        &serde_json::to_vec(&manifest).map_err(|error| error.to_string())?,
    )?;
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(operation_directory.join("new"))
        .map_err(io_error)?;
    sync_directory(&operation_directory)?;
    sync_directory(&target_parent)?;

    state.writes.lock().map_err(lock_error)?.insert(
        id.clone(),
        PendingWrite {
            root,
            target,
            operation_directory,
            file,
            digest: Sha256::new(),
            size: 0,
            expected,
            recoverable: false,
        },
    );
    Ok(WriteStart { id })
}

#[tauri::command]
pub fn write_chunk(
    state: State<'_, DirectorySyncState>,
    id: String,
    data: String,
) -> Result<WriteProgress, String> {
    let bytes = BASE64
        .decode(data)
        .map_err(|_| "Write chunk is not valid base64".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_READ_SIZE {
        return Err(format!("Write size must be between 1 and {MAX_READ_SIZE}"));
    }
    let mut writes = state.writes.lock().map_err(lock_error)?;
    let write = writes
        .get_mut(&id)
        .ok_or_else(|| "Write operation is unavailable".to_string())?;
    write.file.write_all(&bytes).map_err(io_error)?;
    write.digest.update(&bytes);
    write.size = write
        .size
        .checked_add(bytes.len() as u64)
        .ok_or_else(|| "Write size exceeds the supported range".to_string())?;
    Ok(WriteProgress {
        id,
        size: write.size,
    })
}

#[tauri::command]
pub fn commit_write(
    state: State<'_, DirectorySyncState>,
    id: String,
    sha256: String,
) -> Result<CommitResult, String> {
    let mut writes = state.writes.lock().map_err(lock_error)?;
    let write = writes
        .get_mut(&id)
        .ok_or_else(|| "Write operation is unavailable".to_string())?;
    let actual_sha256 = format!("{:x}", write.digest.clone().finalize());
    let prepared = (|| {
        if sha256.len() != 64
            || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !actual_sha256.eq_ignore_ascii_case(&sha256)
        {
            return Err("Staged write hash does not match".to_string());
        }
        assert_target_precondition(&write.target, write.expected.as_ref())?;
        write.file.flush().map_err(io_error)?;
        write.file.sync_all().map_err(io_error)?;
        create_marker(&write.operation_directory, "prepared")
    })();
    if let Err(error) = prepared {
        // Nothing has touched the target yet, so the staged write cannot be reused.
        if let Some(write) = writes.remove(&id) {
            drop(writes);
            let _ = discard_write(write);
        }
        return Err(error);
    }
    write.recoverable = true;

    let backup = write.operation_directory.join("old");
    let backup_retained = if write.target.exists() {
        fs::rename(&write.target, &backup).map_err(io_error)?;
        sync_directory(
            write
                .target
                .parent()
                .ok_or_else(|| "Target parent is unavailable".to_string())?,
        )?;
        sync_directory(&write.operation_directory)?;
        create_marker(&write.operation_directory, "backup-moved")?;
        true
    } else {
        false
    };

    fs::rename(write.operation_directory.join("new"), &write.target).map_err(io_error)?;
    sync_file(&write.target)?;
    sync_directory(
        write
            .target
            .parent()
            .ok_or_else(|| "Target parent is unavailable".to_string())?,
    )?;
    create_marker(&write.operation_directory, "committed")?;
    let size = write.size;
    writes.remove(&id);
    Ok(CommitResult {
        id,
        sha256: actual_sha256,
        size,
        backup_retained,
    })
}

#[tauri::command]
pub fn abort_write(state: State<'_, DirectorySyncState>, id: String) -> Result<bool, String> {
    let mut writes = state.writes.lock().map_err(lock_error)?;
    if writes.get(&id).is_some_and(|write| write.recoverable) {
        return Ok(false);
    }
    let write = writes.remove(&id);
    drop(writes);
    let Some(write) = write else {
        return Ok(false);
    };
    discard_write(write)?;
    Ok(true)
}

fn discard_write(write: PendingWrite) -> Result<(), String> {
    drop(write.file);
    fs::remove_dir_all(write.operation_directory).map_err(io_error)?;
    sync_directory(&write.root.join(RECOVERY_DIRECTORY))
}

#[tauri::command]
pub fn recover_root(root: String) -> Result<RecoveryResult, String> {
    let root = canonical_root(&root)?;
    let recovery_root = root.join(RECOVERY_DIRECTORY);
    if !recovery_root.exists() {
        return Ok(RecoveryResult {
            repaired: Vec::new(),
            discarded: Vec::new(),
            ambiguous: Vec::new(),
        });
    }
    assert_directory(&fs::symlink_metadata(&recovery_root).map_err(io_error)?)?;
    let mut result = RecoveryResult {
        repaired: Vec::new(),
        discarded: Vec::new(),
        ambiguous: Vec::new(),
    };
    for entry in fs::read_dir(&recovery_root).map_err(io_error)? {
        let operation_directory = entry.map_err(io_error)?.path();
        if !operation_directory.is_dir() {
            result
                .ambiguous
                .push(operation_directory.to_string_lossy().into_owned());
            continue;
        }
        let manifest_path = operation_directory.join("manifest.json");
        let manifest: RecoveryManifest = match fs::read(&manifest_path)
            .map_err(io_error)
            .and_then(|bytes| serde_json::from_slice(&bytes).map_err(|error| error.to_string()))
        {
            Ok(manifest) => manifest,
            Err(_) => {
                result
                    .ambiguous
                    .push(operation_directory.to_string_lossy().into_owned());
                continue;
            }
        };
        if operation_directory
            .file_name()
            .and_then(|name| name.to_str())
            != Some(&manifest.id)
        {
            result.ambiguous.push(manifest.id);
            continue;
        }
        let (target, target_parent) = resolve_target(&root, &manifest.target)?;
        let staged = operation_directory.join("new");
        let backup = operation_directory.join("old");
        let committed = operation_directory.join("committed").exists();
        let backup_moved = operation_directory.join("backup-moved").exists();
        let prepared = operation_directory.join("prepared").exists();

        if committed {
            if target.exists() {
                if Utc::now().timestamp_millis() - manifest.created_at
                    >= 30_i64 * 24 * 60 * 60 * 1000
                {
                    fs::remove_dir_all(&operation_directory).map_err(io_error)?;
                    result.discarded.push(manifest.id);
                }
            } else {
                result.ambiguous.push(manifest.id);
            }
        } else if backup_moved {
            if target.exists() {
                result.ambiguous.push(manifest.id);
            } else if staged.exists() {
                fs::rename(&staged, &target).map_err(io_error)?;
                sync_file(&target)?;
                sync_directory(&target_parent)?;
                create_marker(&operation_directory, "committed")?;
                result.repaired.push(manifest.id);
            } else if backup.exists() {
                fs::rename(&backup, &target).map_err(io_error)?;
                sync_directory(&target_parent)?;
                fs::remove_dir_all(&operation_directory).map_err(io_error)?;
                result.repaired.push(manifest.id);
            } else {
                result.ambiguous.push(manifest.id);
            }
        } else if prepared || staged.exists() {
            fs::remove_dir_all(&operation_directory).map_err(io_error)?;
            result.discarded.push(manifest.id);
        } else {
            result.ambiguous.push(manifest.id);
        }
    }
    sync_directory(&recovery_root)?;
    Ok(result)
}

fn scan_pass<F>(
    root: &Path,
    cancelled: &AtomicBool,
    mut emit: F,
) -> Result<(usize, [u8; 32]), String>
where
    F: FnMut(ScanEntry) -> Result<(), String>,
{
    let mut pending = vec![(root.to_path_buf(), String::new())];
    let mut digest = Sha256::new();
    let mut count = 0;

    while let Some((directory, relative_directory)) = pending.pop() {
        check_cancelled(cancelled)?;
        let before = fs::symlink_metadata(&directory).map_err(io_error)?;
        assert_directory(&before)?;
        let before_fingerprint = fingerprint(&before)?;
        let mut children = fs::read_dir(&directory)
            .map_err(io_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(io_error)?;
        children.sort_by(|left, right| left.file_name().cmp(&right.file_name()));

        let mut collision_keys = HashSet::new();
        let mut child_directories = Vec::new();
        for child in children {
            check_cancelled(cancelled)?;
            let name = child
                .file_name()
                .into_string()
                .map_err(|_| "Directory contains a non-Unicode name".to_string())?;
            if name == RECOVERY_DIRECTORY && relative_directory.is_empty() {
                continue;
            }
            validate_portable_name(&name)?;
            if !collision_keys.insert(name.to_lowercase()) {
                return Err(format!(
                    "Directory contains a case-fold name collision: {name}"
                ));
            }
            let metadata = fs::symlink_metadata(child.path()).map_err(io_error)?;
            if metadata.file_type().is_symlink() {
                return Err(format!("Directory contains an unsupported link: {name}"));
            }
            if !metadata.is_dir() && !metadata.is_file() {
                return Err(format!("Directory contains an unsupported entry: {name}"));
            }
            let relative_path = if relative_directory.is_empty() {
                name
            } else {
                format!("{relative_directory}/{name}")
            };
            let entry = ScanEntry {
                path: relative_path.clone(),
                kind: if metadata.is_dir() { "folder" } else { "file" }.into(),
                size: metadata.is_file().then_some(metadata.len()),
                modified: modified(&metadata)?,
                readonly: metadata.permissions().readonly(),
                identity: identity(&metadata),
            };
            digest.update(serde_json::to_vec(&entry).map_err(|error| error.to_string())?);
            digest.update([0]);
            emit(entry)?;
            count += 1;
            if metadata.is_dir() {
                child_directories.push((child.path(), relative_path));
            }
        }
        let after = fs::symlink_metadata(&directory).map_err(io_error)?;
        if fingerprint(&after)? != before_fingerprint {
            return Err("Directory changed during scan".into());
        }
        for child in child_directories.into_iter().rev() {
            pending.push(child);
        }
    }
    Ok((count, digest.finalize().into()))
}

fn hash_open_file(
    root: &Path,
    relative_path: &str,
    cancelled: &AtomicBool,
) -> Result<HashResult, String> {
    let path = resolve_existing(root, relative_path)?;
    let mut file = open_regular_file(&path)?;
    let before = fingerprint(&file.metadata().map_err(io_error)?)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; MAX_READ_SIZE];
    loop {
        check_cancelled(cancelled)?;
        let count = file.read(&mut buffer).map_err(io_error)?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    let after = fingerprint(&file.metadata().map_err(io_error)?)?;
    if after != before {
        return Err("File changed while hashing".into());
    }
    Ok(HashResult {
        sha256: format!("{:x}", digest.finalize()),
        fingerprint: before,
    })
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    if root.trim().is_empty() {
        return Err("Directory path is required".into());
    }
    let root = Path::new(root);
    let metadata = fs::symlink_metadata(root).map_err(io_error)?;
    assert_directory(&metadata)?;
    fs::canonicalize(root).map_err(io_error)
}

fn resolve_existing(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let parts = validate_relative_path(relative_path)?;
    let mut current = root.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        current.push(part);
        let metadata = fs::symlink_metadata(&current).map_err(io_error)?;
        if metadata.file_type().is_symlink() {
            return Err("Sync path contains an unsupported link".into());
        }
        if index + 1 < parts.len() && !metadata.is_dir() {
            return Err("Sync path contains a non-directory component".into());
        }
    }
    let canonical = fs::canonicalize(&current).map_err(io_error)?;
    if !canonical.starts_with(root) {
        return Err("Sync path escapes its selected root".into());
    }
    Ok(canonical)
}

fn resolve_target(root: &Path, relative_path: &str) -> Result<(PathBuf, PathBuf), String> {
    let parts = validate_relative_path(relative_path)?;
    let mut parent = root.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        parent.push(part);
        let metadata = fs::symlink_metadata(&parent).map_err(io_error)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err("Sync target contains an invalid directory component".into());
        }
    }
    let parent = fs::canonicalize(parent).map_err(io_error)?;
    if !parent.starts_with(root) {
        return Err("Sync target escapes its selected root".into());
    }
    let target = parent.join(parts.last().expect("validated path has a final component"));
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
            return Err("Sync target is not a regular file".into());
        }
    }
    Ok((target, parent))
}

fn assert_target_precondition(
    target: &Path,
    expected: Option<&FileFingerprint>,
) -> Result<(), String> {
    match (fs::symlink_metadata(target), expected) {
        (Ok(metadata), Some(expected)) if fingerprint(&metadata)?.eq(expected) => Ok(()),
        (Err(error), None) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        (Ok(_), None) => Err("Sync target already exists".into()),
        (Err(error), Some(_)) if error.kind() == std::io::ErrorKind::NotFound => {
            Err("Sync target was removed".into())
        }
        (Err(error), _) => Err(io_error(error)),
        _ => Err("Sync target changed".into()),
    }
}

fn recovery_root(root: &Path) -> Result<PathBuf, String> {
    let path = root.join(RECOVERY_DIRECTORY);
    match fs::create_dir(&path) {
        Ok(()) => sync_directory(root)?,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            assert_directory(&fs::symlink_metadata(&path).map_err(io_error)?)?;
        }
        Err(error) => return Err(io_error(error)),
    }
    Ok(path)
}

fn write_durable(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    file.write_all(contents).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    sync_directory(
        path.parent()
            .ok_or_else(|| "Manifest parent is unavailable".to_string())?,
    )
}

fn sync_file(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(io_error)
}

fn create_marker(operation_directory: &Path, name: &str) -> Result<(), String> {
    write_durable(&operation_directory.join(name), b"")
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(io_error)
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            CreateFileW, FlushFileBuffers, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE,
            FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        },
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let flushed = unsafe { FlushFileBuffers(handle) };
    unsafe { CloseHandle(handle) };
    if flushed == 0 {
        Err(io_error(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Err("Durable directory flush is unsupported on this platform".into())
}

fn validate_relative_path(relative_path: &str) -> Result<Vec<String>, String> {
    if relative_path.is_empty() || relative_path.contains('\\') || relative_path.contains('\0') {
        return Err("A root-relative file path is required".into());
    }
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("A root-relative file path is required".into());
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part
                    .to_str()
                    .ok_or_else(|| "Sync path must be Unicode".to_string())?;
                validate_portable_name(part)?;
                parts.push(part.to_string());
            }
            _ => return Err("A root-relative file path is required".into()),
        }
    }
    if parts.is_empty() {
        return Err("A root-relative file path is required".into());
    }
    Ok(parts)
}

fn validate_portable_name(name: &str) -> Result<(), String> {
    let lower = name.to_ascii_lowercase();
    let stem = lower.split('.').next().unwrap_or_default();
    let reserved = matches!(stem, "con" | "prn" | "aux" | "nul")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.encode_utf16().count() > 255
        || name.nfc().collect::<String>() != name
        || name.chars().any(|character| {
            character <= '\u{1f}'
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        || name.ends_with(['.', ' '])
        || reserved
    {
        return Err(format!("Directory contains an unsupported name: {name}"));
    }
    Ok(())
}

fn open_regular_file(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000);
    }
    let file = options.open(path).map_err(io_error)?;
    let metadata = file.metadata().map_err(io_error)?;
    if !metadata.is_file() || is_reparse_point(&metadata) {
        return Err("File path is not a regular file".into());
    }
    Ok(file)
}

fn assert_directory(metadata: &Metadata) -> Result<(), String> {
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(metadata) {
        return Err("Sync root is not a regular directory".into());
    }
    Ok(())
}

fn fingerprint(metadata: &Metadata) -> Result<FileFingerprint, String> {
    Ok(FileFingerprint {
        size: metadata.len(),
        modified: modified(metadata)?,
        identity: identity(metadata),
    })
}

fn modified(metadata: &Metadata) -> Result<Option<String>, String> {
    match metadata.modified() {
        Ok(value) => Ok(Some(format_system_time(value))),
        Err(error) if error.kind() == std::io::ErrorKind::Unsupported => Ok(None),
        Err(error) => Err(io_error(error)),
    }
}

fn format_system_time(value: SystemTime) -> String {
    DateTime::<Utc>::from(value).to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[cfg(unix)]
fn identity(metadata: &Metadata) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    Some(format!("{}:{}", metadata.dev(), metadata.ino()))
}

#[cfg(windows)]
fn identity(_metadata: &Metadata) -> Option<String> {
    None
}

#[cfg(not(any(unix, windows)))]
fn identity(_metadata: &Metadata) -> Option<String> {
    None
}

#[cfg(windows)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &Metadata) -> bool {
    false
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        Err("Operation was cancelled".into())
    } else {
        Ok(())
    }
}

fn require_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.is_empty() {
        Err("Operation id is required".into())
    } else {
        Ok(())
    }
}

fn io_error(error: std::io::Error) -> String {
    error.to_string()
}

fn lock_error<T>(_error: std::sync::PoisonError<T>) -> String {
    "Directory sync state is unavailable".into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_and_hashes_regular_files() {
        let temporary = tempfile::tempdir().unwrap();
        fs::create_dir(temporary.path().join("folder")).unwrap();
        fs::write(temporary.path().join("folder/file.txt"), b"vistta").unwrap();
        let cancelled = AtomicBool::new(false);
        let root = canonical_root(&temporary.path().to_string_lossy()).unwrap();

        let mut entries = Vec::new();
        scan_pass(&root, &cancelled, |entry| {
            entries.push(entry);
            Ok(())
        })
        .unwrap();
        assert!(entries
            .iter()
            .any(|entry| entry.path == "folder" && entry.kind == "folder"));
        assert!(entries
            .iter()
            .any(|entry| entry.path == "folder/file.txt" && entry.size == Some(6)));

        let hash = hash_open_file(&root, "folder/file.txt", &cancelled).unwrap();
        assert_eq!(
            hash.sha256,
            "2b941a12176d4b014197e5206763e55dd705939d1d84951878ab92aed08ecdf6"
        );
        assert_eq!(hash.fingerprint.size, 6);
    }

    #[test]
    fn recovery_finishes_a_prepared_replacement() {
        let temporary = tempfile::tempdir().unwrap();
        let recovery = recovery_root(temporary.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let operation = recovery.join(&id);
        fs::create_dir(&operation).unwrap();
        let manifest = RecoveryManifest {
            id: id.clone(),
            target: "file.txt".into(),
            created_at: Utc::now().timestamp_millis(),
            expected: None,
        };
        write_durable(
            &operation.join("manifest.json"),
            &serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        write_durable(&operation.join("new"), b"new").unwrap();
        write_durable(&operation.join("old"), b"old").unwrap();
        create_marker(&operation, "prepared").unwrap();
        create_marker(&operation, "backup-moved").unwrap();

        let result = recover_root(temporary.path().to_string_lossy().into_owned()).unwrap();
        assert_eq!(fs::read(temporary.path().join("file.txt")).unwrap(), b"new");
        assert_eq!(fs::read(operation.join("old")).unwrap(), b"old");
        assert_eq!(result.repaired, vec![id]);
        assert!(result.ambiguous.is_empty());
    }

    #[test]
    fn recovery_does_not_resurrect_a_committed_backup() {
        let temporary = tempfile::tempdir().unwrap();
        let recovery = recovery_root(temporary.path()).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let operation = recovery.join(&id);
        fs::create_dir(&operation).unwrap();
        let manifest = RecoveryManifest {
            id: id.clone(),
            target: "deleted.txt".into(),
            created_at: Utc::now().timestamp_millis(),
            expected: None,
        };
        write_durable(
            &operation.join("manifest.json"),
            &serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        write_durable(&operation.join("old"), b"old").unwrap();
        create_marker(&operation, "committed").unwrap();

        let result = recover_root(temporary.path().to_string_lossy().into_owned()).unwrap();
        assert!(!temporary.path().join("deleted.txt").exists());
        assert_eq!(fs::read(operation.join("old")).unwrap(), b"old");
        assert_eq!(result.ambiguous, vec![id]);
    }
}
