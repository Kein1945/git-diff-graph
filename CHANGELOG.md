# Changelog

## 0.2.0 — 2026-10-15

### Added

- **Exported vs internal symbols.** Exported functions, classes and types have an accent kind label (`FN`) and a dashed line to the edge of their file, as if leaving the module. Internal ones (not exported, `private`, `#private`) are dimmed. The diff panel shows an `exported` / `internal` badge.
- **View filter: Context · Changes · Unstaged.** Unstaged hides everything that is already fully staged, so you can review what is left. The default is Changes, and the choice is remembered.
- **Stage button in the diff panel**, next to the line counts.
- **Copy from the diff panel.** Click the file path to copy it, or click a line to copy `path:line`. Copyable items have a dashed underline.
- **Keyboard shortcuts.** `Shift+1` fit to screen, `1` `2` `3` switch the view filter, `S` stage / unstage the selected block, `Q` / `E` collapse / expand, `?` shortcut help. Letters are physical keys, so they work with any keyboard layout.

### Changed

- The top bar shows the checked-out branch instead of `HEAD` (`main → working tree`, `main~3`). It still shows `HEAD` when HEAD is detached.
- The graph opens at the **Files** zoom level.
- Blocks inside a container are aligned to the left instead of centred.
- Block headers have two click targets: the icon and chevron expand or collapse, the name opens the diff.
- The diff panel is wider: it fits 120 columns of code and takes at most half the screen.

### Fixed

- Live mode crashed with `EACCES` on folders it cannot read, such as Docker volumes, even when nothing in them had changed. The file watcher now skips everything git ignores (`.gitignore` and friends), and a watch error is logged instead of stopping the server.
- Staging a renamed file failed with `pathspec … did not match any files` when the old path was already gone from the index.
- A rename without line changes never showed as staged.
- Row highlights in the diff panel no longer stop at the panel edge when you scroll sideways.
- Selecting a block and pressing a key drew a square focus outline over the rounded block. The selection ring on a staged block now stands off its frame.
