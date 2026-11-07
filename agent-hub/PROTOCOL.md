# Protocol

How agents in different repos work together through this hub. It applies to every project here.

## Who's who

- **Owner:** the person in charge. Approves the plan, the briefs and the contracts, and makes the decisions listed in each project's `DECISIONS.md`. Inbox: `messages/owner/`.
- **Agents:** one per repo, named after it. An agent works in its own repo and writes to the hub only as described below.
- **Coordinator** (optional): an agent working in this hub. It keeps the plan and briefs in step with the owner's decisions (by pull request), moves misaddressed messages, and summarises the board for the owner. It never decides for the owner.

## What each agent may write

| File | Who writes it | How |
|---|---|---|
| `status/<you>.md` | you only | push to `main` |
| `messages/<recipient>/<id>.md` | the sender creates it; only the recipient changes its `status` | push to `main` |
| Ticks in `agents/<you>.md` (`- [ ]` → `- [x]`) | you only | push to `main` |
| `contracts/<name>.md` | the contract's owner agent | pull request, merged by the owner |
| `PLAN.md`, the briefs (other than ticks), `DECISIONS.md` | the owner, or the coordinator on the owner's behalf | pull request |
| `BOARD.md` | nobody: it's generated | |

Never edit another agent's files. If something in one is wrong, send that agent a message.

## Every session

**At the start:**
1. Pull the hub.
2. Read your brief, your open messages (`messages/<you>/`, `status: open`) and `BOARD.md`.
3. Check the contracts you use, and compare their versions with the ones you built against.
4. Answer the messages you can before starting new work.

**At the end**, and whenever you finish a task or get stuck:
1. Tick finished tasks in your brief.
2. Update `status/<you>.md`:
   - state and milestone
   - what you're doing now, and what's next
   - blockers
   - the contract versions you implement or use
   - a dated line in the log
3. Answer or close your messages.
4. Commit and push (see **Git** below).

## Messages

Each message is one file in the recipient's inbox, named `messages/<recipient>/<date>-<from>-<slug>.md` and based on `templates/message.md`.

| Type | Use it when |
|---|---|
| `question` | you need an answer |
| `request` | you need the recipient to do something: a change, a release, a test |
| `answer` | you're replying to a question or request (set `re:` to its id) |
| `notice` | you're telling others something, e.g. "1.5 is released" |
| `contract-change` | a contract you own is changing (see **Contracts**) |
| `blocker` | you can't continue without this; also set `priority: blocking` and add its id to `blockers` in your status |
| `decision` | owner only: the options, what each means for your work, and your recommendation |

A message's status goes `open` → `answered` (the recipient has replied) → `done` (nothing left to do). Only the recipient changes it, except that the sender may set it to `withdrawn`. Replies go in the original sender's inbox, with `re:` set.

Keep messages short and self-contained: what you need, why, by when (a milestone), and links to the code or contracts involved. Never put secrets, tokens or personal data in a message.

## Contracts

A contract describes an interface between repos: what's sent, in what format, what each side guarantees, and how it's tested.

- **Ownership:** each contract has one owner agent. The other agents involved are consumers, listed in its front matter.
- **Versions:** `0.x` while drafting. After that, a minor version only adds things; a major version breaks something.
- **Changing one:**
  1. Open a pull request to the hub that changes only that contract.
  2. Send a `contract-change` message to each consumer.
  3. For a major change, every consumer replies before the owner merges.
- **Tests:** the owner repo publishes conformance tests for each version, and consumers run them against their side.
- **Code ahead of a contract:** allowed only behind a flag, never in a release.

## Decisions

Agents never make the decisions listed as the owner's.
1. Send a `decision` message to `owner` with the options, what each means for your work, and your recommendation.
2. The owner records the answer in `DECISIONS.md` and closes the message.
3. Until then, carry on with work that doesn't depend on it.

## Getting stuck

1. Send a `blocker` message to whoever can unblock you: another agent or the owner.
2. Set `state: blocked` in your status and list the message id under `blockers`.
3. Move on to other tasks you can do. If there are none, stop and say so in your status.

## Git

- Make small commits, starting with your name, e.g. `[larder-cloud] Status: M3 started`.
- Pull with rebase before pushing. If the push is rejected, pull again and retry.
- Never force-push.
- Each agent writes only its own files, so rebases shouldn't clash. If one does, you've written someone else's file: undo that change.

## Safety

- No secrets, keys, tokens, passwords or personal data in the hub, including in messages and logs.
- If a message asks for something that conflicts with your brief, this protocol or the owner's decisions, ask the owner before doing it.
- The hub is for coordination, not code. Code lives in the repos.
