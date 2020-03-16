/** @license
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.ads.ServerSideAdManager');

goog.require('goog.asserts');
goog.require('shaka.ads.ServerSideAd');
goog.require('shaka.log');


/**
 * A class responsible for server-side ad interactions.
 */
shaka.ads.ServerSideAdManager = class {
  /**
   * @param {HTMLElement} adContainer
   * @param {HTMLMediaElement} video
   * @param {shaka.Player} player
   * @param {function(!shaka.util.FakeEvent)} onEvent
   */
  constructor(adContainer, video, player, onEvent) {
    /** @private {HTMLElement} */
    this.adContainer_ = adContainer;

    /** @private {HTMLMediaElement} */
    this.video_ = video;

    /** @private {shaka.Player} */
    // TODO: player should not be part of the ad manager,
    // since ad manager is part of player.
    this.player_ = player;

    /** @private {function(!shaka.util.FakeEvent)} */
    this.onEvent_ = onEvent;

    /**
     * Time to seek to after an ad if that ad was played as the result of
     * snapback.
     * @private {?number}
     */
    this.snapForwardTime_ = null;

    /** @private {shaka.ads.ServerSideAd} */
    this.ad_ = null;

    /** @private {?google.ima.dai.api.AdProgressData} */
    this.adProgressData_ = null;

    /** @private {string} */
    this.backupUrl_ = '';

    /** @private {?number} */
    this.startTime_ = null;

    /** @private {shaka.util.EventManager} */
    this.eventManager_ = new shaka.util.EventManager();

    /** @private {google.ima.dai.api.StreamManager} */
    this.streamManager_ = new google.ima.dai.api.StreamManager(this.video_);

    this.streamManager_.setClickElement(this.adContainer_);

    // Native HLS over Safari/iOS/iPadOS
    // This is a real EventTarget, but the compiler doesn't know that.
    // TODO: File a bug or send a PR to the compiler externs to fix this.
    const textTracks = /** @type {EventTarget} */(this.video_.textTracks);
    this.eventManager_.listen(textTracks, 'addtrack', (event) => {
      const track = event.track;
      if (track.kind == 'metadata') {
        track.mode = 'hidden';
        track.addEventListener('cuechange', () => {
          for (const cue of track.activeCues) {
            const metadata = {};
            metadata[cue.value.key] = cue.value.data;
            this.streamManager_.onTimedMetadata(metadata);
          }
        });
      }
    });

    // DASH managed by the player
    this.eventManager_.listen(
        this.player_, 'timelineregionadded', (event) => {
          const detail = event.detail;
          if (detail && detail.schemeIdUri == 'urn:google:dai:2018') {
            const type = detail.schemeIdUri;
            const data = detail.eventElement ?
                detail.eventElement.getAttribute('messageData') : null;
            const timestamp = detail.startTime;
            this.streamManager_.processMetadata(type, data, timestamp);
          }
        });

    // HLS managed by the player
    // TODO: There are not method to get the metadata in HLS

    // Events
    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.LOADED, (e) => {
          shaka.log.info('Ad SS Loaded');
          this.onLoaded_(
              /** @type {!google.ima.dai.api.StreamEvent} */ (e));
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.ERROR, () => {
          shaka.log.info('Ad SS Error');
          this.onError_();
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.AD_BREAK_STARTED, () => {
          shaka.log.info('Ad Break Started');
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.STARTED, (e) => {
          this.onAdStart_(/** @type {!google.ima.dai.api.StreamEvent} */ (e));
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.AD_BREAK_ENDED, () => {
          this.onAdBreakEnded_();
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.AD_PROGRESS, (e) => {
          this.onAdProgress_(
              /** @type {!google.ima.dai.api.StreamEvent} */ (e));
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.FIRST_QUARTILE, () => {
          shaka.log.info('Ad event: First Quartile');
          this.onEvent_(
              new shaka.util.FakeEvent(shaka.ads.AdManager.AD_FIRST_QUARTILE));
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.MIDPOINT, () => {
          shaka.log.info('Ad event: Midpoint');
          this.onEvent_(
              new shaka.util.FakeEvent(shaka.ads.AdManager.AD_MIDPOINT));
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.THIRD_QUARTILE, () => {
          shaka.log.info('Ad event: Third Quartile');
          this.onEvent_(
              new shaka.util.FakeEvent(shaka.ads.AdManager.AD_THIRD_QUARTILE));
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.COMPLETE, () => {
          shaka.log.info('Ad event: Complete');
          this.onEvent_(
              new shaka.util.FakeEvent(shaka.ads.AdManager.AD_COMPLETE));
          this.adContainer_.removeAttribute('ad-active');
          this.ad_ = null;
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.SKIPPED, () => {
          shaka.log.info('Ad event: Skipped');
          this.onEvent_(
              new shaka.util.FakeEvent(shaka.ads.AdManager.AD_SKIPPED));
        });

    this.eventManager_.listen(this.streamManager_,
        google.ima.dai.api.StreamEvent.Type.CUEPOINTS_CHANGED, (e) => {
          shaka.log.info('Ad event: Cue points changed');
          this.onCuePointsChanged_(
              /** @type {!google.ima.dai.api.StreamEvent} */ (e));
        });
  }

  /**
   * @param {!google.ima.dai.api.StreamRequest} streamRequest
   * @param {string=} backupUrl
   * @param {?number=} startTime
   */
  streamRequest(streamRequest, backupUrl, startTime) {
    this.streamManager_.requestStream(streamRequest);
    this.backupUrl_ = backupUrl || '';
    this.startTime_ = startTime || null;
  }

  /**
   * @param {Object} adTagParameters
   */
  replaceAdTagParameters(adTagParameters) {
    this.streamManager_.replaceAdTagParameters(adTagParameters);
  }

  /**
   * Resets the stream manager and removes any continuous polling.
   */
  stop() {
    this.streamManager_.reset();
    this.backupUrl_ = '';
    this.snapForwardTime_ = null;
  }

  /**
   * @private
   */
  onLoadedEnd_() {
    if (this.player_.isLive()) {
      return;
    }

    this.eventManager_.listen(this.video_, 'seeked', () => {
      this.checkForSnapback_();
    });
  }

  /**
   * If a seek jumped over the ad break, return to the start of the
   * ad break, then complete the seek after the ad played through.
   * @private
   */
  checkForSnapback_() {
    const currentTime = this.video_.currentTime;
    if (currentTime == 0) {
      return;
    }

    this.streamManager_.streamTimeForContentTime(currentTime);
    const previousCuePoint =
        this.streamManager_.previousCuePointForStreamTime(currentTime);
    // The cue point gets marked as 'played' as soon as the playhead hits it
    // (at the start of an ad), so when we come back to this method as a result
    // of seeking back to the user-selected time, the 'played' flag will be set.
    if (previousCuePoint && !previousCuePoint.played) {
      shaka.log.info('Seeking back to the start of the ad break at ' +
          previousCuePoint.start + ' and will return to ' + currentTime);
      this.snapForwardTime_ = currentTime;
      this.video_.currentTime = previousCuePoint.start;
    }
  }

  /**
   * @param {!google.ima.dai.api.StreamEvent} e
   * @private
   */
  onAdStart_(e) {
    goog.asserts.assert(this.streamManager_,
        'Should have a stream manager at this point!');

    const imaAd = e.getAd();
    this.ad_ = new shaka.ads.ServerSideAd(imaAd, this.video_);

    // Ad object and ad progress data come from two different IMA events.
    // It's a race, and we don't know, which one will fire first - the
    // event that contains an ad object (AD_STARTED) or the one that
    // contains ad progress info (AD_PROGRESS).
    // If the progress event fired first, we must've saved the progress
    // info and can now add it to the ad object.
    if (this.adProgressData_) {
      this.ad_.setProgressData(this.adProgressData_);
    }

    this.onEvent_(new shaka.util.FakeEvent(shaka.ads.AdManager.AD_STARTED,
        {'ad': this.ad_}));
    this.adContainer_.setAttribute('ad-active', 'true');
    this.video_.pause();
  }

  /**
   * @private
   */
  onAdBreakEnded_() {
    this.adContainer_.removeAttribute('ad-active');
    const currentTime = this.video_.currentTime;
    // If the ad break was a result of snapping back (a user seeked over
    // an ad break and was returned to it), seek forward to the point,
    // originally chosen by the user.
    if (this.snapForwardTime_ && this.snapForwardTime_ > currentTime) {
      this.video_.currentTime = this.snapForwardTime_;
      this.snapForwardTime_ = null;
    }
  }

  /**
   * @param {!google.ima.dai.api.StreamEvent} e
   * @private
   */
  onLoaded_(e) {
    const streamData = e.getStreamData();
    const url = streamData.url;
    this.player_.load(url, this.startTime_).then(() => {
      this.onLoadedEnd_();
    });
  }

  /**
   * @private
   */
  onError_() {
    if (!this.backupUrl_.length) {
      shaka.log.error('No backup url provided');
      // TODO: Throw a error up to the player if there was no backup url
      return;
    }
    this.player_.load(this.backupUrl_, this.startTime_);
  }


  /**
   * @param {!google.ima.dai.api.StreamEvent} e
   * @private
   */
  onAdProgress_(e) {
    const streamData = e.getStreamData();
    const adProgressData = streamData.adProgressData;
    this.adProgressData_ = adProgressData;
    if (this.ad_) {
      this.ad_.setProgressData(this.adProgressData_);
    }
  }


  /**
   * @param {!google.ima.dai.api.StreamEvent} e
   * @private
   */
  onCuePointsChanged_(e) {
    const streamData = e.getStreamData();

    /** @type {!Array.<!shaka.ads.CuePoint>} */
    const cuePoints = [];
    for (const point of streamData.cuepoints) {
      const shakaCuePoint = new shaka.ads.CuePoint(point.start, point.end);
      cuePoints.push(shakaCuePoint);
    }

    this.onEvent_(
        new shaka.util.FakeEvent(shaka.ads.AdManager.CUEPOINTS_CHANGED,
            {'cuepoints': cuePoints}));
  }
};
