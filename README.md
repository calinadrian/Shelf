# Shelf

Shelf is a local-first book tracker for the web and Android. Search Open Library,
track reading progress and ratings, and complete reading quests without creating
an account.

## Development

Requirements: Node.js and, for Android builds, Android Studio with the Android SDK.

```sh
npm test
npm run sync:web
npm run cap:sync
```

The project-root web files are the source of truth. `sync:web` stages them in
`www/` before Capacitor builds. Run `npm run check` to check JavaScript syntax,
run unit tests, and verify that `www/` is current.

## Data and backups

Books are stored locally in IndexedDB. Quest progress, streaks, theme, and view
preferences use local storage. The Library tab can export books, quests, and the
reading streak to a versioned JSON backup and restore that backup later. Imports
replace the current library only after confirmation.

Book search and cover images come from Open Library, so those features require
an internet connection.
