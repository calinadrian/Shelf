import { initEpubFile } from '@lingo-reader/epub-parser';
import { initMobiFile } from '@lingo-reader/mobi-parser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { WorkerMessageHandler } from 'pdfjs-dist/legacy/build/pdf.worker.mjs';

// Keep the fallback worker in the app bundle. Browsers prohibit dynamically
// importing module workers from file:// pages, while PDF.js can run this
// handler safely on its main-thread LoopbackPort in that environment. Hosted
// and Capacitor builds retain the faster real worker.
if (window.location.protocol === 'file:') globalThis.pdfjsWorker = { WorkerMessageHandler };
else delete globalThis.pdfjsWorker;
window.ShelfReaderLibs = { initEpubFile, initMobiFile, pdfjs };
