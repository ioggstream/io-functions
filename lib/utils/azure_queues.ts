/**
 * Implements utility functions for Azure Storage queues
 */
import * as winston from "winston";

import { Context } from "@azure/functions";
import { QueueService } from "azure-storage";

import * as t from "io-ts";

import { Either, left, right } from "fp-ts/lib/Either";
import { Option, some } from "fp-ts/lib/Option";
import {
  isTransientError,
  RuntimeError,
  toRuntimeError,
  TransientError
} from "io-functions-commons/dist/src/utils/errors";
import { ReadableReporter } from "italia-ts-commons/lib/reporters";

// see https://docs.microsoft.com/en-us/rest/api/storageservices/get-messages#response-body
export const QueueMessage = t.intersection([
  t.interface({
    dequeueCount: t.number,
    id: t.string,
    popReceipt: t.string
  }),
  t.partial({
    expirationTime: t.string,
    insertionTime: t.string,
    messageId: t.string,
    messageText: t.string,
    nextVisibleTime: t.string,
    queue: t.string,
    queueTrigger: t.string,
    timeNextVisible: t.string
  })
]);

// see https://github.com/Azure/azure-storage-node/blob/master/lib/services/queue/models/queuemessageresult.js
export type QueueMessage = t.TypeOf<typeof QueueMessage>;

// Any delay must be less than 7 days (< 604800 seconds).
// See the maximum value of the TimeToLiveSeconds field
// in the OpenApi specs (api/definitions.yaml)
const MAX_BACKOFF_MS = 7 * 24 * 3600 * 1000;
const MIN_BACKOFF_MS = 285;

// MAX_RETRIES *must* equal (maxDequeueCount - 1)
// if (MAX_RETRIES < maxDequeueCount) - 1 there will be other extraneous
//    #(maxDequeueCount - MAX_RETRIES) retries with the default visibilityTimeout
//    before putting the message into the poison queue
// if (MAX_RETRIES > maxDequeueCount - 1) the system will retry even after maxDequeueCount
//    is reached and duplicate messages will be put into the poison queue
export const MAX_RETRIES = Math.floor(
  Math.log2(MAX_BACKOFF_MS / MIN_BACKOFF_MS)
);

/**
 * Compute the timeout in seconds before the message will be processed again.
 * returns none in case the maximum number of retries is reached
 */
export const getDelaySecForRetries = (
  retries: number,
  maxRetries = MAX_RETRIES,
  minBackoff = MIN_BACKOFF_MS
): Option<number> =>
  some(retries)
    .filter(nr => nr <= maxRetries)
    .map(nr => Math.ceil((minBackoff * Math.pow(2, nr)) / 1000));

/* istanbul ignore next */
export function queueMessageToString(queueMessage: QueueMessage): string {
  return [
    "queueTrigger = ",
    queueMessage.queueTrigger,
    "; expirationTime = ",
    queueMessage.expirationTime,
    "; insertionTime = ",
    queueMessage.insertionTime,
    "; nextVisibleTime = ",
    queueMessage.nextVisibleTime,
    "; id = ",
    queueMessage.id,
    "; popReceipt = ",
    queueMessage.popReceipt,
    "; dequeueCount = ",
    queueMessage.dequeueCount
  ].join("");
}

/**
 * Update message visibilityTimeout with an incremental delay.
 *
 * You MUST call context.done(retryMsg) or throw an exception in the caller
 * to schedule a retry (the re-processing of a message in the queue).
 *
 * Useful in case of transient errors. The message is enqueued with
 * a newly computed visibilityTimeout (proportional to dequeueCount)
 *
 * @param queueService  The Azure storage queue service
 * @param queueName     The Azure storage queue name
 * @param context       The Functions context with bindings
 *
 * @return              False if message is expired.
 */
export function updateMessageVisibilityTimeout(
  queueService: QueueService,
  queueName: string,
  queueMessageBindings: Context["bindings"]
): Promise<boolean> {
  const queueMessageValidation = QueueMessage.decode(queueMessageBindings);
  if (queueMessageValidation.isLeft()) {
    winston.error(
      `Unable to decode queue message from bindings: ${ReadableReporter.report(
        queueMessageValidation
      )}`
    );
    return Promise.reject(new Error("INVALID_QUEUE_MESSAGE_IN_BINDINGS"));
  }
  const queueMessage = queueMessageValidation.value;
  return new Promise(resolve => {
    winston.debug(
      `updateMessageVisibilityTimeout|Retry to handle message ${queueName}:${queueMessageToString(
        queueMessage
      )}`
    );

    // dequeueCount starts with one (not zero)
    const numberOfRetries = queueMessage.dequeueCount;

    return getDelaySecForRetries(numberOfRetries)
      .map(visibilityTimeoutSec => {
        // update message visibilityTimeout
        queueService.updateMessage(
          queueName,
          queueMessage.id,
          queueMessage.popReceipt,
          visibilityTimeoutSec,
          err => {
            if (err) {
              winston.error(
                `updateMessageVisibilityTimeout|Error|${err.message}`
              );
            }
            winston.debug(
              `updateMessageVisibilityTimeout|retry=${numberOfRetries}|timeout=${visibilityTimeoutSec}|queueMessageId=${
                queueMessage.id
              }`
            );
            // try to schedule a retry even in case updateMessage fails
            resolve(true);
          }
        );
      })
      .getOrElseL(() => {
        winston.debug(
          `updateMessageVisibilityTimeout|Maximum number of retries reached|retries=${numberOfRetries}|${
            queueMessage.id
          }`
        );
        resolve(false);
      });
  });
}

/**
 * Call this method in the catch handler of a queue handler to:
 *
 * - execute onTransientError() in case of Transient Error
 * - execute onPermanentError() in case of Permanent Error
 * - trigger a retry in case of TransientError
 *   and retriesNumber < maxRetriesNumber
 */
export async function handleQueueProcessingFailure(
  queueService: QueueService,
  queueMessageBindings: Context["bindings"],
  queueName: string,
  onTransientError: (error: RuntimeError) => Promise<Either<RuntimeError, {}>>,
  onPermanentError: (error: RuntimeError) => Promise<Either<RuntimeError, {}>>,
  error: Error | RuntimeError
): Promise<void> {
  const runtimeError = toRuntimeError(error);
  if (isTransientError(runtimeError)) {
    winston.warn(`Transient error|${queueName}|${runtimeError.message}`);
    const shouldTriggerARetry = await updateMessageVisibilityTimeout(
      queueService,
      queueName,
      queueMessageBindings
    );
    // execute the callback for transient errors
    await onTransientError(runtimeError)
      .then(errorOrResult =>
        errorOrResult.mapLeft(err =>
          winston.warn(
            `Transient error (onTransientError)|${queueName}|${err.message}`
          )
        )
      )
      .catch(winston.error);
    if (shouldTriggerARetry) {
      // throws to trigger a retry in the caller handler
      // must be an Error in order to be logged correctly
      // by the Azure Functions runtime
      throw new Error(`Retry|${queueName}|${runtimeError.message}`);
    } else {
      winston.error(
        `Maximum number of retries reached, stop processing|${queueName}|${
          runtimeError.message
        }`
      );
    }
  } else {
    winston.error(`Permanent error|${queueName}|${runtimeError.message}`);
    // execute the callback for permanent errors
    await onPermanentError(runtimeError).then(
      errorOrResult =>
        errorOrResult.fold(
          // try to trigger a retry in case any error
          // occurs during the execution of the callback
          callbackError =>
            handleQueueProcessingFailure(
              queueService,
              queueMessageBindings,
              queueName,
              onTransientError,
              onPermanentError,
              TransientError(callbackError.message)
            ),
          // exits (stop processing) in case no error
          // occurs during the execution of the callback
          async () => void 0
        )
      // do not catch here, let it throw
    );
  }
}

/**
 * Promisify queueService.getQueueMetadata
 */
/* istanbul ignore next */
export function getQueueMetadata(
  queueService: QueueService,
  queueName: string
): Promise<Either<Error, QueueService.QueueResult>> {
  return new Promise(resolve =>
    queueService.getQueueMetadata(queueName, (error, result) => {
      if (error) {
        return resolve(left<Error, QueueService.QueueResult>(error));
      }
      return resolve(right<Error, QueueService.QueueResult>(result));
    })
  );
}
