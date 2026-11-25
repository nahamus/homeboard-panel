# HomeBoard control panel

Static control panel for the HomeBoard Roku screensaver:
**https://nahamus.github.io/homeboard-panel/**

This page holds no data. After you sign in with a fine-grained GitHub token
(Contents: Read and write on the private data repo only), it reads and saves
`board.json` there through the GitHub API. The token is kept in your browser's
local storage and is only sent to `api.github.com`.

Source lives in the roku-home-board project (`control/index.html`); publish
changes with `control/deploy-panel.ps1`.
