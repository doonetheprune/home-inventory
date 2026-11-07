---
name: example
owner: some-agent
consumers: [agent-a, agent-b]
version: 0.1
status: draft          # draft | agreed | released | replaced
---

# Contract: example

## Purpose

What this interface is for, in two or three sentences.

## Parties and transport

Who talks to whom, and how: HTTP, WebSocket, files, Firestore…

## Messages, endpoints and data

The exact shapes, with examples.

## Guarantees

What each side promises: ordering, retries, limits, timeouts.

## Errors

What can go wrong, and what each side does about it.

## Versions

What's compatible with what.

## Conformance tests

Where they live, and how each side runs them.

## Changes

- 0.1 (date): first draft.
