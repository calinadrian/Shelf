# Shelf

Shelf is a local-first book tracker for the web and Android. Search Open Library,
track reading progress and ratings, and complete reading quests without creating
an account.

The Library can also import EPUB, MOBI, and PDF ebooks for offline reading inside
Shelf. Imported files and the last reading position are stored locally on the
device. JSON backups include ebook metadata, but intentionally omit the binary
book files; re-import those files after restoring a backup.

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
button in the header is pressed. When a newer version is found, it downloads the
APK and opens Android's installer. Updates are accepted only from GitHub release
assets for that repository.

### Publish an update

1. In `android/app/build.gradle`, increase both version values. `versionCode`
   must be a larger integer every time; `versionName` is the human-readable
   release version. For example, the next release after `1.1.0` could use
   `versionCode 3` and `versionName "1.2.0"`.
2. Run `npm run cap:sync` to copy the current web app into the Android project.
3. Open the Android project with `npm run cap:android`.
4. In Android Studio, choose **Build → Generate Signed Bundle / APK → APK**,
   select the `release` variant, and sign it with the same production keystore
   used for the version already installed on the phone. Save that keystore
   safely—an APK signed with a different key cannot update the installed app.
5. Create a GitHub release in `calinadrian/Shelf` with a tag matching the app
   version, such as `v1.2.0`, and attach exactly one release APK. The updater
   selects the `.apk` asset from GitHub's latest release.
6. On the phone, open Shelf and tap the update button in the header. Approve the
   download, then approve Android's installer. Android 8+ may first ask you to
   allow Shelf to install unknown apps; enable that permission for Shelf and tap
   the update button again.

The GitHub release tag must be newer than the installed `versionName`. For
example, an app at `1.1.0` will install a release tagged `v1.2.0`, but will not
offer `v1.1.0` again. Test each release on a device before publishing it widely.
