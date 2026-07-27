# Local network sync

WebRequestKit is local-first: every machine keeps its own database and works
offline. Sync exchanges only the rows that changed since last time, and where
two people edited the same request, **the newer edit wins**.

One machine **shares** its workspace; the others add it as a **peer**. Sync is
symmetric — each round trip pushes your changes and pulls theirs — so it does
not matter who shares and who connects. Any number of peers is supported, and
peers can sync with each other in any arrangement.

## What syncs

| Shared with peers | Stays on this machine |
| --- | --- |
| Folders and requests | Open tabs and their responses |
| Environments and variables | Which environment is selected |
| Mock routes | Monitor run history |
| Monitors | Proxy flows, load-test results |
| Comments and replies | Appearance and app settings |
| Request docs | Sync peer list and pairing token |

## Setup

### 1. Share from one machine

1. Open **Sync** in the left rail.
2. Leave the port at `7420` (any free port works) and keep the generated
   pairing token, or type your own.
3. Click **Start sharing**.

The panel then shows the exact address and token to type on the other machines,
for example:

```
192.168.1.20:7420
token: k3f8s1a0zx92mq7c
```

Sharing binds to all network interfaces, so anything that can reach this machine
on that port can attempt to sync — the pairing token is what stops it.

### 2. Connect the other machines

On each other machine:

1. Open **Sync** → **+ Add peer**.
2. Enter the host (`192.168.1.20:7420`) and the pairing token exactly as shown.
3. Click **Test** to confirm it is reachable and the clocks agree.
4. **Choose the workspace** — this step matters, see below.
5. Click **Sync**.

### Choosing the workspace

Sync pairs **one workspace** at a time, and both machines have to agree on
which. Every machine generates its own workspace ids, so two workspaces that
happen to share a name are still different workspaces.

Each peer has a workspace selector:

- **Mine — “Name”** pushes your workspace to that peer. It appears there on
  the first sync.
- **Theirs — “Name”** adopts one of theirs. Click **Load theirs** to fetch the
  list, pick one, and sync — it then shows up in your workspace switcher.

Pick one direction and stay with it. Changing the selection resets that peer's
watermarks, so the next sync re-checks everything.

Under **Last sync** each peer reports what actually moved, for example
`sent 12, received 0`. If both numbers stay at 0, the two machines are pointed
at different workspaces.

### 3. Keep it in sync

Three modes, from least to most eager:

- **Manual** — click **Sync** on a peer, or **Sync all**.
- **Auto-sync** — every 30 seconds, minute, or 5 minutes, for peers with
  **Auto** ticked.
- **Live** — changes propagate in about a second.

A machine that is sharing also receives pushes from its peers immediately — you
do not need auto-sync on the sharing side to receive changes.

## Live sync

Tick **Live** and both directions become push-driven:

- **Outbound** — the app watches its own database for edits (a local query, no
  network traffic) and pushes to every enabled peer as soon as something
  changes.
- **Inbound** — it holds an open connection to each peer's change stream
  (`GET /events`, server-sent events). When a peer reports a change, it pulls
  from that peer at once.

A peer shows `● live` when its stream is connected. Dropped connections retry
every 3 seconds, so a machine that sleeps and wakes reconnects on its own.
Between changes the stream sends a heartbeat every 20 seconds to stop idle
connections being dropped.

Live mode does not change how conflicts resolve — it just shortens the window
in which two people can edit the same request without seeing each other.

## Export to a file

The **↑** button in the collection sidebar writes the workspace — folders,
requests, docs and environments — to a single JSON file. **↓** imports OpenAPI,
Swagger and Postman collections. The exported format is the same document
GitHub sync commits.

## GitHub sync

For teammates who are not on your network, or simply to keep history, the
**Sync** view can commit the workspace to a repository.

1. Create a personal access token with **repo** scope
   (Settings → Developer settings → Personal access tokens on GitHub).
2. Fill in the repository (`owner/repo`), branch, path and token.
3. **Check access** confirms the token works and the repo is writable.
4. **Push** commits the collection; **Pull** replaces the local collection with
   the repository's copy.

The collection is stored as one pretty-printed JSON file, so changes review as
readable diffs. Pushes carry the blob SHA from your last pull — if someone else
committed in the meantime, the push is **rejected rather than overwriting**
them. Pull, check the result, then push again.

GitHub sync and LAN sync are independent and can be used together: LAN sync for
the people next to you, GitHub for history and everyone else.

> Environment values are committed as written. Leave secrets blank in the
> variables you commit, or use a private repository.

## Working in the same workspace

Sync is scoped to the **workspace you have open**. Peers are stored per
workspace, so:

- Pair each workspace separately, or
- Keep everyone in one shared workspace and use folders for separation.

A workspace that does not exist on the receiving machine is created
automatically the first time its rows arrive.

## Conflicts

Resolution is per row, not per collection: if you rename request A while a
colleague edits request B, both changes survive. If you *both* edit request A,
the edit with the newer timestamp wins and the other is overwritten.

This makes clock accuracy matter. If a peer's clock is more than 30 seconds
away from yours, the Sync panel warns you — the machine running fast would win
every conflict. Any normal NTP setup keeps this a non-issue.

Deletions propagate as tombstones, so removing a folder on one machine removes
it everywhere on the next sync rather than being resurrected by the peer that
still has it.

## Security

- Traffic is **plain HTTP on your local network**, protected by the pairing
  token. Anyone on the network who has the token can read and write the
  workspace.
- Treat the token like a password. Change it (stop sharing, edit, start again)
  if it leaks; peers will need the new one.
- Turn sharing off when you are done — it is off by default and does not start
  automatically.
- Do not expose the port through a router or firewall to the internet. If you
  need remote access, use a VPN or SSH tunnel between the machines rather than
  port forwarding.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "cannot reach host" | Wrong address or port, machine asleep, or a firewall blocking the port. Confirm with `curl http://HOST:PORT/ping` |
| "the peer rejected this pairing token" | Tokens differ — copy it again from the sharing machine |
| Changes do not appear, `sent 0, received 0` | The peer is pointed at a different workspace — use **Load theirs** and pick the one you both want |
| "this peer has no workspace with id …" | Same cause: the workspace you selected does not exist on that machine |
| A colleague's edit was overwritten | Both edited the same request; the newer timestamp won. Check the clock-skew warning |
| Deleted item came back | The other machine had not synced since the delete — sync it once more |

To check a peer from the terminal:

```sh
curl http://192.168.1.20:7420/ping
# {"app":"webrequestkit","now":1769500000000}
```
