import { verify } from 'node:crypto';
import * as crypto from 'node:crypto';

export const forbiddenSignatureVerification = [verify, crypto.verify];
