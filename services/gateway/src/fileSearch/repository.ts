// The file_search data layer's one import path. The code lives in the modules below, by responsibility:
//
//   recall.ts           recallCandidates: hybrid recall (vector arms + full-text arm, fused by RRF)
//   recallTypes.ts      recall's option, candidate and row shapes, candidateId
//   recallInput.ts      recall's checks of its query text, query vectors and vector arms
//   recallErrors.ts     RecallInputError, driverErrorCode, redactDriverError
//   recallSql.ts        the store-access and active-generation predicates, the arm and full-text SQL
//   recallSettings.ts   the recall session settings and the pgvector probe
//   recallAnn.ts        the approximate (HNSW) path of a vector arm
//   storeValidation.ts  attribute, dimension and expiry checks and their errors
//   stores.ts           vector store rows: create, share, list, read
//   storeFiles.ts       attach, enqueue, detach and the deletes
//   storeAccess.ts      touchStoreActivity, ToolRequestError, assertStoresAccessible
//
// Import from HERE, never from a module above: tests replace this module (jest.mock) or one of its
// functions (jest.spyOn), and only a caller that imports through it sees the replacement. For the same
// reason every value is re-exported as a plain property (an `export * from` binding is a getter that
// jest.spyOn cannot replace); the modules call each other directly, as the functions of the single
// file did, so a replacement here never reaches a call between them.
import * as recall from './recall';
import * as recallErrors from './recallErrors';
import * as recallTypes from './recallTypes';
import * as recallSql from './recallSql';
import * as recallSettings from './recallSettings';
import * as storeValidation from './storeValidation';
import * as stores from './stores';
import * as storeFiles from './storeFiles';
import * as storeAccess from './storeAccess';

export type { RecallOptions, VectorArm, CandidateChunk } from './recallTypes';
export type { LexicalRankFunction } from './recallSql';
export type {
  VectorStoreRow, VectorStoreFileRow, AttachStamp, FileStatus, FileCounts, CreateStoreOptions, VisibleStoreRow,
  ListVisibleStoresOptions,
} from './stores';

export const RecallInputError = recallErrors.RecallInputError;
export type RecallInputError = recallErrors.RecallInputError;
export const driverErrorCode = recallErrors.driverErrorCode;
export const redactDriverError = recallErrors.redactDriverError;

export const candidateId = recallTypes.candidateId;

export const ACTIVE_GENERATION_PREDICATE_SQL = recallSql.ACTIVE_GENERATION_PREDICATE_SQL;
export const MAX_QUERY_TERMS = recallSql.MAX_QUERY_TERMS;
export const OR_QUERY_SQL = recallSql.OR_QUERY_SQL;
export const BOUNDED_OR_QUERY_SQL = recallSql.BOUNDED_OR_QUERY_SQL;
export const ORDERED_SCAN_SETTINGS_SQL = recallSql.ORDERED_SCAN_SETTINGS_SQL;
export const SERIAL_SCAN_SQL = recallSql.SERIAL_SCAN_SQL;
export const SERIAL_FILES_SCAN_SQL = recallSql.SERIAL_FILES_SCAN_SQL;
export const setLexicalRankFunction = recallSql.setLexicalRankFunction;

export const recallEfSearch = recallSettings.recallEfSearch;
export const __resetRecallSettingsForTests = recallSettings.__resetRecallSettingsForTests;

export const recallCandidates = recall.recallCandidates;

export const StoreDimensionMismatchError = storeValidation.StoreDimensionMismatchError;
export type StoreDimensionMismatchError = storeValidation.StoreDimensionMismatchError;
export const AttributeValidationError = storeValidation.AttributeValidationError;
export type AttributeValidationError = storeValidation.AttributeValidationError;
export const validateAttributes = storeValidation.validateAttributes;
export const assertStoreDimension = storeValidation.assertStoreDimension;
export const StoreExpiredError = storeValidation.StoreExpiredError;
export type StoreExpiredError = storeValidation.StoreExpiredError;
export const assertStoreNotExpired = storeValidation.assertStoreNotExpired;

export const VALID_FILE_STATUSES = stores.VALID_FILE_STATUSES;
export const createStore = stores.createStore;
export const setStoreShared = stores.setStoreShared;
export const shareStoreWithTeam = stores.shareStoreWithTeam;
export const unshareStoreFromTeam = stores.unshareStoreFromTeam;
export const deleteTeamShares = stores.deleteTeamShares;
export const teamIdsOfStores = stores.teamIdsOfStores;
export const readStoreRow = stores.readStoreRow;
export const MAX_VISIBLE_STORES_LIMIT = stores.MAX_VISIBLE_STORES_LIMIT;
export const listVisibleStores = stores.listVisibleStores;
export const readVisibleStore = stores.readVisibleStore;

export const attachFile = storeFiles.attachFile;
export const enqueueIngestion = storeFiles.enqueueIngestion;
export const deleteStoreFile = storeFiles.deleteStoreFile;
export const deleteFileDetachingEverywhere = storeFiles.deleteFileDetachingEverywhere;
export const deleteStoreCascade = storeFiles.deleteStoreCascade;

export const touchStoreActivity = storeAccess.touchStoreActivity;
export const ToolRequestError = storeAccess.ToolRequestError;
export type ToolRequestError = storeAccess.ToolRequestError;
export const assertStoresAccessible = storeAccess.assertStoresAccessible;
