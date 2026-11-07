## Working with the other repos

This repo is part of the **<project>** project, coordinated through the agent hub (`doonetheprune/agent-hub`). You are the **`<agent>`** agent.

- **At the start of each session**, pull the hub. It's normally cloned beside this repo as `../agent-hub`; if it isn't there, ask for it to be added to the session. Then read:
  - `PROTOCOL.md`
  - your brief, `projects/<project>/agents/<agent>.md`
  - your open messages in `projects/<project>/messages/<agent>/`
  - the board
  - the contracts you use
- **Before you finish:**
  - tick finished tasks in your brief
  - update `projects/<project>/status/<agent>.md`
  - answer or close your messages
  - push the hub
- **The rules:**
  - Write only your own files in the hub.
  - Interfaces with other repos are the contracts in `projects/<project>/contracts/`; change one only as `PROTOCOL.md` describes.
  - The decisions listed in `DECISIONS.md` belong to the owner: ask, don't decide.
