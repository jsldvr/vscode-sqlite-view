# SQLite View

SQLite View is a local database workbench for Visual Studio Code. It keeps a library of SQLite files in the Primary Sidebar and opens each database as an editor with table browsing, direct record editing, schema tools, SQL execution, transfer tools, charts, and a command log.

## Current features

- Register existing `.db`, `.db3`, `.sqlite`, and `.sqlite3` files.
- Create and compact database files.
- Browse tables and views with paging, sorting, and cross-column search.
- Insert, update, and delete records, including composite primary keys and rowid fallback.
- Inspect tables, views, indexes, triggers, columns, generated columns, and `WITHOUT ROWID` tables.
- Create tables and indexes, add/rename/drop columns, rename tables, and drop schema objects with confirmation.
- Execute one or more SQLite statements and inspect bounded result sets, changes, timing, and errors.
- Build common `SELECT` statements from table, column, filter, order, and limit controls.
- Import and export table CSV files.
- Import and export complete SQL dumps.
- Plot a simple bar chart from the most recent query result.
- Inspect a redacted, per-session log of application-issued SQL.
- Add, change, or remove SQLCipher encryption when the optional native SQLCipher runtime is available.

SQLite View commits database mutations immediately. VS Code's Save and Undo commands do not wrap database transactions.

## Run from source

Requirements: Node.js 20.17 or newer and a desktop VS Code version compatible with the extension manifest.

```bash
npm install
npm install-scripts approve sqlite3
npm run compile
```

Press F5 in VS Code to start an Extension Development Host.

## Verify and package

```bash
npm run lint
npm test
npm run package
```

The VSIX bundles the installed Windows native SQLite runtime. Cross-platform releases must be packaged and runtime-tested on their corresponding Windows, macOS, and Linux targets.

## Releases

Pushing a package version to `main` runs the release workflow. The workflow requires a matching non-empty changelog heading in this form:

```text
## [0.2.0] - 2026-08-02
```

If `v0.2.0` does not already exist, the workflow verifies the project, stages SQLite's N-API binary for seven desktop targets, creates target-specific VSIX files, and publishes them in a GitHub release. Existing tags or releases are a successful no-op. Prerelease package versions such as `0.2.0-beta.1` create GitHub prereleases.

Automated release artifacts guarantee standard SQLite. The optional SQLCipher runtime is excluded from the cross-platform release jobs until it has its own target-specific build and runtime validation.

Local commits run TypeScript type checking and ESLint against staged TypeScript files through Husky. Run the complete release gate manually with:

```bash
npm run release:check
```

## SQLCipher

SQLCipher support is loaded from the optional `@journeyapps/sqlcipher` dependency. Version 6 currently supports source builds on macOS and Linux only; its publisher does not support Windows. On a supported platform, approve that package's install script and provide the native compiler and crypto prerequisites described by the package. If no compatible runtime is available, standard SQLite remains usable and encryption commands report that SQLCipher is unavailable.

Passwords are held in process memory only. They are never written to workspace settings, global state, SQL dumps, or the SQL log.

Encryption changes create and verify a new database, move the original to a timestamped `.backup` path, then install the replacement. The user chooses whether to keep or explicitly delete that backup.

## Data behavior and limitations

- Large browse operations are paged. SQL result transfer is capped by `sqliteView.queryRowLimit`.
- Tables without primary keys use `rowid` when available. `WITHOUT ROWID` tables without a declared primary key are read-only in the grid.
- BLOBs are displayed by size and transported as base64. Existing BLOBs are not edited as text.
- The schema pane handles common creation and deletion workflows. Arbitrary `ALTER TABLE`, pragma, trigger, view, virtual-table, and extension-specific operations are available through the SQL editor.
- CSV import treats fields as text and lets SQLite apply column affinity.
- SQL dump import executes the selected script as supplied. Review untrusted SQL before importing it.
- External writers can change a row after it is displayed. Updates and deletes fail if their locator no longer identifies exactly one row.

## Manual verification checklist

1. Add or create a database from the SQLite Activity Bar.
2. Expand its tables, views, indexes, and triggers in the sidebar.
3. Open the database, create a table, and add, edit, search, sort, and delete a row.
4. Run read and write statements from the SQL tab.
5. Export and re-import a table as CSV and a database as SQL.
6. Plot a numeric query result and inspect the SQL log.
7. On a supported build, encrypt a disposable database and verify it can be reopened.

## Security

The workbench uses a restrictive webview Content Security Policy. Database values are rendered with DOM text nodes, application-generated values are bound parameters, identifiers are quoted, destructive schema and encryption actions require confirmation, and SQLCipher keys are redacted.
