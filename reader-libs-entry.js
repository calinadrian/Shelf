import { initEpubFile } from '@lingo-reader/epub-parser';
import { initMobiFile } from '@lingo-reader/mobi-parser';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

window.ShelfReaderLibs = { initEpubFile, initMobiFile, pdfjs };
