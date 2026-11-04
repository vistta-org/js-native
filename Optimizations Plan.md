# Android background optimizations plan

**Status:** Step 1 (quick fixes) applied. Step 2 (background delivery)
implemented; the Kotlin module compiles, nothing verified on a device yet.
Connect does not flag any event yet.

**Goal:** reduce battery drain on Android and remove the permanent "Background
sync active" notification, while still letting chosen socket events (for
example notifications and file sync) reach the app in real time when it is
backgrounded.

**Constraints:**

- No Google Play Services (no FCM).
- No third-party push distributors (no UnifiedPush, ntfy, etc.).
- No scheduled polling (WorkManager): 15-minute minimum interval and
  multi-hour Doze delays are not acceptable.

Without FCM, the only way left to receive data in real time while backgrounded
is a persistent connection held by a foreground service. Android 8+ stops
ordinary background services within about a minute, so the service, and its
notification, are required whenever background delivery is wanted. The design
below keeps that service running only when the app actually needs it.

## Root cause

On mobile, `Socket.connect` in `packages/js/core/socket.js` always uses the
native `VisttaSocket` bridge. Before Step 1, that bridge promoted
`VisttaService` to a foreground service and held a wake lock for as long as the
socket was open, which is the whole app session.

## Findings

| #   | Location                                                                                                                             | Effect                                                                                                                                    | Status          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | `VisttaNetwork.kt` `connectSocket` calls `VisttaService.socketOpened()` on every connect                                             | Foreground service and its notification stay up for as long as the socket is open.                                                        | Fixed in Step 2 |
| 2   | `VisttaNetwork.kt`: 1 h `PARTIAL_WAKE_LOCK` renewed every 30 min while any socket is open                                            | CPU never deep-sleeps. Most likely the largest battery cost.                                                                              | Fixed in Step 1 |
| 3   | `VisttaNetwork.kt` socket options: unlimited reconnect attempts, `reconnectionDelayMax = 5000`                                       | When the server is unreachable, the device retries every 5 s forever.                                                                     | Fixed in Step 1 |
| 4   | Socket.IO heartbeat at the 25 s server default                                                                                       | Frequent heartbeats keep the cellular radio active.                                                                                       | Fixed in Step 1 |
| 5   | `plugins/clipboard.js` `watchBackground` fallback (2 s poll, started from `connect/components/sync/provider.jsx`) used the scheduler | Without Shizuku, a 2 s native timer kept the service alive and ran JS every 2 s, although Android 10+ returns nothing while backgrounded. | Fixed in Step 1 |
| 6   | `VisttaService.kt`: `START_STICKY`, `specialUse`, no end condition while the main socket is open                                     | The service never stops during a session.                                                                                                 | Fixed in Step 2 |

## Step 1: Quick fixes (applied)

- **Wake lock (#2).** `VisttaNetwork` no longer holds a permanent wake lock.
  Each incoming socket event takes a 10 s timed lock so it is delivered before
  the device sleeps again.
- **Reconnects (#3).** Reconnect backoff grows up to 5 minutes. A
  default-network callback disconnects sockets when the device loses its network
  (no retries while offline) and reconnects immediately, with a reset backoff,
  when a new default network appears. Adds the `ACCESS_NETWORK_STATE`
  permission.
- **Heartbeat (#4).** The `@vistta/js` Socket.IO server pings every 60 s instead
  of 25 s, for all clients. A silently dropped connection is detected after up
  to 80 s instead of 45 s.
- **Clipboard polling (#5).** The non-Shizuku fallback uses a plain
  `setInterval`. It no longer starts the foreground service; on Android it only
  runs while the app is visible, the only time Android allows the read.

**To verify on a device:**

- Battery use over a night with the app backgrounded.
- `disconnect()` followed by `connect()` on the same Java Socket.IO client
  reconnects correctly after a network change.
- Whether Doze cuts network access for the foreground service now that no
  permanent wake lock is held.

## Step 2: Background delivery (implemented)

### API

Socket events stay ordinary events. When writing a listener, the developer
decides whether that event is delivered while the app is backgrounded:

```javascript
Socket.on("notification", onNotification, { mobile: { background: true } });
Socket.on(`sync:changed:${userId}`, onSyncChanged, { mobile: { background: true } });
Socket.on("presence", onPresence); // delivered only while the mobile app is in the foreground
```

A non-boolean `mobile.background` throws a `TypeError`.

**Desktop and web deliver every event**, whether or not the window is visible.
The cost being avoided (foreground service, notification, radio wake-ups,
Doze) is mobile-specific; desktop apps using `app.background: true` or
`app.visible: false` expect to keep working while hidden; and with
`app.multipleInstances: true` every hidden instance would drop events and
resync each time it is shown. Hence the `mobile` namespace in the option.

### Behaviour on Android

| App state                                 | Socket      | Foreground service | Events delivered                                    |
| ----------------------------------------- | ----------- | ------------------ | --------------------------------------------------- |
| Foreground                                | Connected   | Only if flagged    | All, as before                                      |
| Backgrounded, no background listener      | Left open   | Not running        | None (Android freezes the process soon after)       |
| Backgrounded, at least one background one | Connected   | Running            | Flagged events only; others dropped natively        |
| Resumed after events were dropped         | Reconnected | As above           | All; `disconnect` + `connect` trigger `onReconnect` |

Decisions:

- **The socket is never closed for being backgrounded.** Without a foreground
  service Android freezes the process; the server times the connection out
  and the client reconnects on resume.
- **The service starts when the first background listener registers** and
  stops when the last one is removed (scheduler timers and the clipboard
  monitor still count separately). Its notification is therefore visible
  while the app is open whenever such a listener exists. If the start is
  refused because the app is already backgrounded (Android 12+), it is retried
  on the next resume.
- **"Backgrounded" means the activity is stopped** (`onStop`), not merely
  paused, so dialogs and permission prompts do not drop events.
- **Dropped events are not replayed.** On resume, each socket that dropped
  events dispatches `disconnect` to JS and then reconnects, so the existing
  `onReconnect` resync in `connect/app/page.jsx` runs. System events
  (`connect`, `disconnect`, `connect_error`) follow the same rule as any other
  event.
- **Wake lock.** Only delivered events take the 10 s wake lock.

### Implementation

1. **`packages/js/core/socket.js`** — `Socket.on(event, callback, options)`
   validates `mobile.background` and passes the options to the mobile socket.
2. **`packages/js-native/plugins/net/socket.js`** — `on(id, name, handler,
{ mobile: { background } })` reference-counts background listeners per
   socket and event and calls `VisttaSocket.setBackground(id, name, true |
false)` on the first and last listener. `disconnect(id)` releases all of
   them; `reconnect(id, ...)` keeps them.
3. **`VisttaPlugin.kt`** — `setBackground` bridge method; `onStop` /
   `onResume` overrides report the app state to `VisttaNetwork`.
4. **`VisttaNetwork.kt`** — per-socket set of background event names, the
   background filter in `dispatchSocketEvent`, dropped-event tracking and the
   resume reconnect. Sockets no longer start or stop the service.
5. **`VisttaService.kt`** — `socketOpened` / `socketClosed` replaced by
   `setBackgroundEvents(context, active)` and `resumePendingStart(context)`.
   The service no longer shuts down the sockets when it is destroyed.

### Open risk: work inside handlers in the background

Delivery itself works: native code pushes each event into the WebView and the
handler runs. Earlier device debugging found that about 60 s after the app
leaves the foreground, even with the screen on, the WebView stalls timers and
`window.fetch`, while promises and the native fetch bridge keep working:

| Inside a background handler, after ~60 s backgrounded         | Works? |
| ------------------------------------------------------------- | ------ |
| The handler, `await`, promises                                | Yes    |
| `request` / `Net.fetch` (Connect routes `request` through it) | Yes    |
| `setTimeout` / `setInterval` (debounce, retries, delays)      | No     |
| `window.fetch` directly                                       | No     |

To check before flagging events in Connect:

- Whether the sync and notification code paths depend on timers or direct
  `window.fetch`.
- If they do: keep the WebView's timers running while a background listener
  exists, for example by resuming it from `VisttaPlugin` after Wry pauses it.
  Unverified whether this un-stalls JS.

### Notifications

- On Android 13+ the notification permission must be granted, or nothing is
  shown regardless of delivery.
- Events missed while disconnected are recovered by the resync on reconnect.
  The app decides whether resynced items should still raise notifications.

### Heartbeat

The 60 s heartbeat is shared by all clients, because Socket.IO sets it per
server, not per socket. A longer heartbeat only for backgrounded clients would
need a separate connection. Measure on a device first; consider it only if the
heartbeat turns out to be the main remaining cost.

### Reliability

| Device / setup                                                                              | Expected delivery                                                                                                            |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Battery-optimization exemption, stock-like Android (Pixel, Motorola, LineageOS, GrapheneOS) | Near real-time.                                                                                                              |
| No exemption                                                                                | Usually fine; Doze may delay delivery while idle (unverified, needs device testing).                                         |
| Aggressive manufacturers (Xiaomi/MIUI, Huawei, some Samsung/OnePlus/Oppo)                   | Service may be killed. The user must allow autostart / "no restrictions" in the manufacturer's settings (dontkillmyapp.com). |

- **Battery-optimization exemption.** Offer an API to request
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` so the app can ask when the user turns
  on a feature that relies on background delivery. Restricted by Play policy;
  fine for self-distributed apps.
- **Limitation: background delivery needs a running app.** Background
  listeners are registered by JS, so they exist only after the app has
  started. After a reboot, a force-stop or the process being killed, nothing
  is delivered until the user opens the app again. Restarting only the service
  (on boot or from a watchdog) would not help, because it can't restore the JS
  listeners; out of scope for now.

### Making the service notification less intrusive

- Use a minimum-importance channel: no status-bar icon, collapsed at the bottom
  of the drawer. Behaviour per Android version unverified.
- Android 14+ lets users swipe the notification away; the service keeps
  running.
- Users can disable the channel in system settings; Android 13+ then lists the
  service only in the active-apps panel.
- Show a meaningful text (which features keep the app connected) and open the
  app when tapped.

### Acceptance (to verify on a device)

- With no background listener: no foreground service and no notification at
  any time; after resume the socket reconnects and the app resyncs.
- With at least one background listener: the service and notification appear,
  flagged events reach their handlers while backgrounded (screen off, more
  than 60 s), other events are dropped, and the app resyncs on resume when
  events were dropped.
- Removing the last background listener stops the service.
- How quickly the Java client notices a dead connection after the process is
  unfrozen (it may wait for its ping timeout, up to about 80 s).
- Overnight battery use with the app backgrounded is measured before and after,
  on at least one stock-like device and one aggressive manufacturer.

## Next steps

1. Choose which Connect events use `mobile: { background: true }` (file sync,
   notifications) and check their handlers against the table above.
2. Device verification of Steps 1 and 2.
