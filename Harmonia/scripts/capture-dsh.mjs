import { fileURLToPath } from 'node:url';
import { startUpstreamCapture } from '../lib/upstream-capture.mjs';

startUpstreamCapture(process.env.DSH_CHATLOG_DIR || fileURLToPath(new URL('../../chatlog/', import.meta.url)));
