import * as mongoose from "mongoose";

import { IMessageModel, MessageModel } from "./models/message";

import { messageSchema } from "./schemas/message";

// Setup Mongoose

( mongoose as any ).Promise = global.Promise;

const MONGODB_CONNECTION: string = process.env.CUSTOMCONNSTR_development;
const connection: mongoose.Connection = mongoose.createConnection(
  MONGODB_CONNECTION,
  {
    config: {
      autoIndex: false, // do not autoIndex on connect, see http://mongoosejs.com/docs/guide.html#autoIndex
    },
  },
);

const messageModel = new MessageModel(connection.model<IMessageModel>("Message", messageSchema));

interface IContext {
  bindingData: {
    queueTrigger?: string;
    expirationTime?: Date;
    insertionTime?: Date;
    nextVisibleTime?: Date;
    id: string;
    popReceipt: string;
    dequeueCount: number;
  };
  log: (msg: any, params?: any) => any;
  done: (err?: any, props?: any) => void;
}

interface IContextWithBindings extends IContext {
  bindings: {
    createdMessage?: IMessagePayload;
  };
}

interface IMessagePayload {
  messageId?: string;
}

export function index(context: IContextWithBindings) {
  if (context.bindings.createdMessage != null) {
    const message: IMessagePayload = context.bindings.createdMessage;
    if (message.messageId != null) {
      context.log(`Dequeued message [${message.messageId}].`);
      messageModel.findMessage(message.messageId).then(
        (storedMessage) => {
          if (storedMessage != null) {
            context.log(`Message [${message.messageId}] recipient is [${storedMessage.fiscalCode}].`);
          } else {
            context.log(`Message [${message.messageId}] not found.`);
          }
          context.done();
        },
        (error) => {
          context.log(`Error while querying message [${message.messageId}].`);
          // in case of error, fail to trigger a retry
          context.done(error);
        },
      );
    } else {
      context.log(`Fatal! Message ID is null.`);
      context.done();
    }
  } else {
    context.log(`Fatal! No message found in bindings.`);
    context.done();
  }
}

/*
2017-08-14T13:58:19.356 Queue trigger function processed work item { messageId: '5991ac7944430d3670b81b74' }
2017-08-14T13:58:19.356 queueTrigger = {"messageId":"5991ac7944430d3670b81b74"}
2017-08-14T13:58:19.356 expirationTime = 8/21/2017 1:58:17 PM +00:00
2017-08-14T13:58:19.356 insertionTime = 8/14/2017 1:58:17 PM +00:00
2017-08-14T13:58:19.356 nextVisibleTime = 8/14/2017 2:08:19 PM +00:00
2017-08-14T13:58:19.356 id= 5f149158-92fa-4aaf-84c9-667750fdfaad
2017-08-14T13:58:19.356 popReceipt = AgAAAAMAAAAAAAAAtS7dxwYV0wE=
2017-08-14T13:58:19.356 dequeueCount = 1
*/