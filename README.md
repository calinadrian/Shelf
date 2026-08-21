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

## Android updates from GitHub

The Android app checks the latest release of `calinadrian/Shelf` when the update
button in the header is pressed. Publish releases with a semantic tag such as
`v1.1.0` and attach one `.apk` asset. Increase both `versionCode` and
`versionName` in `android/app/build.gradle` for every release.

Every release APK must be signed with the same production signing key. Android
will reject an update signed with another key. On Android 8 and newer, the user
must also allow Shelf to install unknown apps and approve the Android installer;
the app cannot silently bypass those system confirmations.
