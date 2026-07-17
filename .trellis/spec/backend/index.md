# Backend Development Guidelines

> Best practices for backend development in this project (`pi-lark-hub`).

---

## Overview

This directory contains guidelines for backend development of the multi-Pi Feishu hub and bridge.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | To fill |
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | To fill |
| [Error Handling](./error-handling.md) | Hub/bridge errors, remote queue, fail-closed routing | Filled |
| [Quality Guidelines](./quality-guidelines.md) | No followUp for remote tasks; no stdin/stderr TUI chrome | Filled |
| [Multi-Pi Lark Hub](./multi-pi-lark-hub.md) | Hub/bridge protocol, routing, config, Feishu modes | Filled |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | To fill |

---

## How to Fill These Guidelines

For each guideline file:

1. Document your project's **actual conventions** (not ideals)
2. Include **code examples** from your codebase
3. List **forbidden patterns** and why
4. Add **common mistakes** your team has made

The goal is to help AI assistants and new team members understand how YOUR project works.

---

**Language**: All documentation should be written in **English** (hub product docs may be Chinese).
