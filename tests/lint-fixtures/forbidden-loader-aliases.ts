import cryptoDefault from 'node:crypto';
import cryptoEquals = require('crypto');
import { createRequire as makeRequire } from 'node:module';

declare const require: (specifier: string) => unknown;
declare const module: { require: (specifier: string) => unknown };

const load = require;
const boundLoad = require.bind(null);
const runtimeLoad = makeRequire(import.meta.url);
const memberLoad = module.require;
const computedMemberLoad = module['require'];

export const forbiddenLoaderAliases = [
  cryptoDefault,
  cryptoEquals,
  load('jose'),
  boundLoad('jws'),
  runtimeLoad('jsonwebtoken'),
  memberLoad('jws'),
  computedMemberLoad('node:crypto'),
];
