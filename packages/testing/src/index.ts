export { diffPngs, type PixelDiff } from "./pdf/pixeldiff.ts";
export { pyhankoValidate, type SignatureCheck } from "./pdf/tools.ts";
export {
  DEFAULT_THRESHOLD,
  verifyCorpus,
  verifyFile,
  type CorpusRow,
  type Expectation,
  type VerifyOptions,
  type VerifyResult,
} from "./pdf/verify.ts";
