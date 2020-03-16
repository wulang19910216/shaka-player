/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.test.ManifestParser');


shaka.test.ManifestParser = class {
  /**
   * Verifies the segment references of a stream.
   *
   * @param {?shaka.extern.Stream} stream
   * @param {!Array.<shaka.media.SegmentReference>} references
   */
  static verifySegmentIndex(stream, references) {
    expect(stream).toBeTruthy();
    expect(stream.segmentIndex).toBeTruthy();

    if (references.length == 0) {
      expect(stream.segmentIndex.seek(0)).toBe(null);
      return;
    }

    // Even if the first segment doesn't start at 0, this should return the
    // first segment.
    expect(stream.segmentIndex.seek(0)).toEqual(references[0]);

    for (const expectedRef of references) {
      // Don't query negative times.  Query 0 instead.
      const startTime = Math.max(0, expectedRef.startTime);
      const actualRef = stream.segmentIndex.seek(startTime);
      // NOTE: A custom matcher for SegmentReferences is installed, so this
      // checks the URIs as well.
      expect(actualRef).toEqual(expectedRef);
    }

    // Make sure that the references stop at the end.
    const lastExpectedReference = references[references.length - 1];
    const referenceAfterEnd =
        stream.segmentIndex.seek(lastExpectedReference.endTime);
    expect(referenceAfterEnd).toBe(null);
  }

  /**
   * Creates a segment reference using a relative URI.
   *
   * @param {string} uri A relative URI to http://example.com
   * @param {number} position
   * @param {number} start
   * @param {number} end
   * @param {string=} baseUri
   * @param {number=} startByte
   * @param {?number=} endByte
   * @return {!shaka.media.SegmentReference}
   */
  static makeReference(uri, position, start, end, baseUri = '',
      startByte = 0, endByte = null) {
    const getUris = () => [baseUri + uri];

    // If a test wants to verify these, they can be set explicitly after
    // makeReference is called.
    const initSegmentReference = /** @type {?} */({
      asymmetricMatch: (value) => {
        return value == null ||
            value instanceof shaka.media.InitSegmentReference;
      },
    });

    const timestampOffset = /** @type {?} */(jasmine.any(Number));
    const appendWindowStart = /** @type {?} */(jasmine.any(Number));
    const appendWindowEnd = /** @type {?} */(jasmine.any(Number));

    return new shaka.media.SegmentReference(
        position, start, end, getUris, startByte, endByte,
        initSegmentReference,
        timestampOffset,
        appendWindowStart,
        appendWindowEnd);
  }
};
