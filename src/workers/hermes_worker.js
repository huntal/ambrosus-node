/*
Copyright: Ambrosus Technologies GmbH
Email: tech@ambrosus.com

This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.

This Source Code Form is “Incompatible With Secondary Licenses”, as defined by the Mozilla Public License, v. 2.0.
*/

import express from 'express';

import PeriodicWorker from './periodic_worker';
import HermesUploadStrategy from './hermes_strategies/upload_strategy';
import healthCheckHandler from '../routes/health_check';
import errorHandling from '../middlewares/error_handling';
import asyncMiddleware from '../middlewares/async_middleware';

export default class HermesWorker extends PeriodicWorker {
  constructor(dataModelEngine, uploadRepository, strategy, logger, serverPort) {
    super(strategy.workerInterval, logger);
    this.dataModelEngine = dataModelEngine;
    this.bundleSequenceNumber = 0;
    this.strategy = strategy;
    this.uploadRepository = uploadRepository;
    this.expressApp = express();
    this.serverPort = serverPort;

    this.expressApp.get('/health', asyncMiddleware(
      healthCheckHandler(dataModelEngine.mongoClient, uploadRepository.uploadsWrapper.web3)
    ));
    this.expressApp.use(errorHandling(logger));

    if (!(this.strategy instanceof HermesUploadStrategy)) {
      throw new Error('A valid strategy must be provided');
    }
  }

  async work() {
    // .call() is a workaround for
    // https://github.com/babel/babel/issues/3930#issuecomment-254827874
    await super.work.call(this);
    this.server = this.expressApp.listen(this.serverPort);
  }

  async teardown() {
    await super.teardown.call(this);
    this.server.close();
  }

  async periodicWork() {
    const bundleSizeLimit = await this.uploadRepository.bundleSizeLimit();
    const bundle = await this.dataModelEngine.initialiseBundling(this.bundleSequenceNumber, bundleSizeLimit);

    if (await this.strategy.shouldBundle(bundle)) {
      await this.performBundling(bundle);
    } else {
      await this.dataModelEngine.cancelBundling(this.bundleSequenceNumber);
      this.logger.info('Bundling process canceled');
    }
  }

  async performBundling(bundle) {
    this.logger.info('Trying to upload bundle...');
    const storagePeriods = this.strategy.storagePeriods();
    const result = await this.dataModelEngine.finaliseBundling(bundle, this.bundleSequenceNumber, storagePeriods);
    if (result !== null) {
      this.logger.info({message: 'Bundle successfully uploaded', bundleId: result.bundleId});
      await this.strategy.bundlingSucceeded();
      this.bundleSequenceNumber++;
    }
  }
}
