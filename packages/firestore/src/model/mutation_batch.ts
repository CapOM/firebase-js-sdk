/**
 * @license
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Timestamp } from '../api/timestamp';
import { SnapshotVersion } from '../core/snapshot_version';
import { BatchId, ProtoByteString } from '../core/types';
import { assert } from '../util/assert';
import * as misc from '../util/misc';
import {
  documentKeySet,
  DocumentKeySet,
  DocumentMap,
  documentVersionMap,
  DocumentVersionMap,
  getDocument
} from './collections';
import { Document } from './document';
import { DocumentKey } from './document_key';
import { Mutation, MutationResult } from './mutation';

export const BATCHID_UNKNOWN = -1;

/**
 * A batch of mutations that will be sent as one unit to the backend.
 */
export class MutationBatch {
  /**
   * @param batchId The unique ID of this mutation batch.
   * @param localWriteTime The original write time of this mutation.
   * @param baseMutations Mutations that are used to populate the base
   * values when this mutation is applied locally. This can be used to locally
   * overwrite values that are persisted in the remote document cache. Base
   * mutations are never sent to the backend.
   * @param mutations The user-provided mutations in this mutation batch.
   * User-provided mutations are applied both locally and remotely on the
   * backend.
   */
  constructor(
    public batchId: BatchId,
    public localWriteTime: Timestamp,
    public baseMutations: Mutation[],
    public mutations: Mutation[]
  ) {
    assert(mutations.length > 0, 'Cannot create an empty mutation batch');
  }

  /**
   * Applies all the mutations in this MutationBatch to the specified document
   * to create a new remote document
   *
   * @param docKey The key of the document to apply mutations to.
   * @param maybeDoc The document to apply mutations to.
   * @param batchResult The result of applying the MutationBatch to the
   * backend.
   */
  // DC: Simpler type! (both maybeDoc and the return value)
  applyToRemoteDocument(
    docKey: DocumentKey,
    maybeDoc: Document,
    batchResult: MutationBatchResult
  ): Document {
    assert(
      maybeDoc.key.isEqual(docKey),
      `applyToRemoteDocument: key ${docKey} should match maybeDoc key
      ${maybeDoc.key}`
    );

    const mutationResults = batchResult.mutationResults;
    assert(
      mutationResults.length === this.mutations.length,
      `Mismatch between mutations length
      (${this.mutations.length}) and mutation results length
      (${mutationResults.length}).`
    );

    for (let i = 0; i < this.mutations.length; i++) {
      const mutation = this.mutations[i];
      if (mutation.key.isEqual(docKey)) {
        const mutationResult = mutationResults[i];
        maybeDoc = mutation.applyToRemoteDocument(maybeDoc, mutationResult);
      }
    }
    return maybeDoc;
  }

  /**
   * Computes the local view of a document given all the mutations in this
   * batch.
   *
   * @param docKey The key of the document to apply mutations to.
   * @param maybeDoc The document to apply mutations to.
   */
  // DC: Simpler type! (both maybeDoc and the return value)
  applyToLocalView(docKey: DocumentKey, maybeDoc: Document): Document {
    assert(
      maybeDoc.key.isEqual(docKey),
      `applyToLocalDocument: key ${docKey} should match maybeDoc key
      ${maybeDoc.key}`
    );

    // First, apply the base state. This allows us to apply non-idempotent
    // transform against a consistent set of values.
    for (const mutation of this.baseMutations) {
      if (mutation.key.isEqual(docKey)) {
        maybeDoc = mutation.applyToLocalView(
          maybeDoc,
          maybeDoc,
          this.localWriteTime
        );
      }
    }

    const baseDoc = maybeDoc;

    // Second, apply all user-provided mutations.
    for (const mutation of this.mutations) {
      if (mutation.key.isEqual(docKey)) {
        maybeDoc = mutation.applyToLocalView(
          maybeDoc,
          baseDoc,
          this.localWriteTime
        );
      }
    }
    return maybeDoc;
  }

  /**
   * Computes the local view for all provided documents given the mutations in
   * this batch.
   */
  // DC: Type may be too broad. The input and output can now contain UNKNOWN
  // documents where they couldn't before. This may be harmless.
  applyToLocalDocumentSet(maybeDocs: DocumentMap): DocumentMap {
    // TODO(mrschmidt): This implementation is O(n^2). If we apply the mutations
    // directly (as done in `applyToLocalView()`), we can reduce the complexity
    // to O(n).
    let mutatedDocuments = maybeDocs;
    this.mutations.forEach(m => {
      const baseDocument = getDocument(m.key, maybeDocs);
      const mutatedDocument = this.applyToLocalView(m.key, baseDocument);
      if (!mutatedDocument.unknown) {
        mutatedDocuments = mutatedDocuments.insert(m.key, mutatedDocument);
      }
    });
    return mutatedDocuments;
  }

  keys(): DocumentKeySet {
    return this.mutations.reduce(
      (keys, m) => keys.add(m.key),
      documentKeySet()
    );
  }

  isEqual(other: MutationBatch): boolean {
    return (
      this.batchId === other.batchId &&
      misc.arrayEquals(this.mutations, other.mutations) &&
      misc.arrayEquals(this.baseMutations, other.baseMutations)
    );
  }
}

/** The result of applying a mutation batch to the backend. */
export class MutationBatchResult {
  private constructor(
    readonly batch: MutationBatch,
    readonly commitVersion: SnapshotVersion,
    readonly mutationResults: MutationResult[],
    readonly streamToken: ProtoByteString,
    /**
     * A pre-computed mapping from each mutated document to the resulting
     * version.
     */
    readonly docVersions: DocumentVersionMap
  ) {}

  /**
   * Creates a new MutationBatchResult for the given batch and results. There
   * must be one result for each mutation in the batch. This static factory
   * caches a document=>version mapping (docVersions).
   */
  static from(
    batch: MutationBatch,
    commitVersion: SnapshotVersion,
    results: MutationResult[],
    streamToken: ProtoByteString
  ): MutationBatchResult {
    assert(
      batch.mutations.length === results.length,
      'Mutations sent ' +
        batch.mutations.length +
        ' must equal results received ' +
        results.length
    );

    let versionMap = documentVersionMap();
    const mutations = batch.mutations;
    for (let i = 0; i < mutations.length; i++) {
      versionMap = versionMap.insert(mutations[i].key, results[i].version);
    }

    return new MutationBatchResult(
      batch,
      commitVersion,
      results,
      streamToken,
      versionMap
    );
  }
}
