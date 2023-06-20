import {RuntimeConnector} from "@dataverse/runtime-connector";
import {RuntimeConnectorSigner} from "@dataverse/utils-toolkit";
import {Client} from "@xmtp/xmtp-js";
import {ModelIds, XmtpEnv} from "./types";
import {ListMessagesOptions, ListMessagesPaginatedOptions} from "@xmtp/xmtp-js/dist/types/src/Client";
import {stringToUint8Array, uint8ArrayToString} from "./constants";
import {DecodedMessage} from "@xmtp/xmtp-js/dist/types/src/Message";

export class XmtpClient {

  public appName: string;
  public runtimeConnector: RuntimeConnector
  public signer: RuntimeConnectorSigner
  public modelIds: ModelIds
  public env: XmtpEnv

  public xmtp: Client | undefined
  // public modelIds: ModelIds;


  constructor({
                runtimeConnect,
                appName,
                modelIds,
                env
              }: {
    runtimeConnect: RuntimeConnector,
    appName: string,
    modelIds: ModelIds,
    env: XmtpEnv,
  }) {
    this.runtimeConnector = runtimeConnect;
    this.appName = appName;
    this.modelIds = modelIds;
    this.env = env;
    this.signer = new RuntimeConnectorSigner(this.runtimeConnector);
  }

  async getKeys(){
    const {exist, value } = await this._checkCache(this.modelIds.keys_cache);
    if(exist) {
      console.log("hit key cache ......");
      const keys = await this._unlockKeys(value);
      return stringToUint8Array(keys);
    }

    console.log("process get keys ......");
    const keys = await Client.getKeys(this.signer, {env: this.env});
    await this._persistKeys(keys)
    return keys;
    // return await Client.getKeys(this.signer, {env: this.env});
  }

  async lazyInitClient(){
    if(this.xmtp == undefined) {
      console.log("create new xmtp ");
      const keys = await this.getKeys();
      console.log("keys:  ", keys);
      this.xmtp = await Client.create(null, {
        env: this.env,
        privateKeyOverride: keys,
      })
      return this.xmtp as Client;
    }
    console.log("use old xmtp ");
    return this.xmtp as Client;
  }

  async allConversations(){
    const xmtp = await this.lazyInitClient();
    return xmtp.conversations.list();
  }

  async getMessageWith({to, opts}: {to: string, opts: ListMessagesOptions}) {
    await this.assertUserOnNetwork(to);
    const xmtp = await this.lazyInitClient();
    const conversation = await xmtp.conversations.newConversation(to);
    return conversation.messages(opts);
  }

  async getMessageWithPaginated({to, opts}: {to: string, opts?: ListMessagesPaginatedOptions }) {
    const xmtp = await this.lazyInitClient();
    await this.assertUserOnNetwork(to);
    const conversation = await xmtp.conversations.newConversation(to);
    console.log("conversation " , conversation);
    return conversation.messagesPaginated(opts);
  }

  async sendMessageTo({to, msg}: {to: string, msg: string}) {
    console.log("sendMessageTo： ", to, msg)
    const xmtp = await this.lazyInitClient();
    await this.assertUserOnNetwork(to);
    const conversation = await xmtp.conversations.newConversation(to);
    const decodedMsg = await conversation.send(msg);
    await this._persistMessage(decodedMsg);
    return decodedMsg;
  }

  // todo:
  async listMessages(){
    console.log("to be implemented ")
  }

  async getConversationStream() {
    const xmtp = await this.lazyInitClient();
    return xmtp.conversations.stream();
  }

  async getMessageStreamWith(user: string) {
    await this.assertUserOnNetwork(user);
    const xmtp = await this.lazyInitClient();
    const conversation = await xmtp.conversations.newConversation(user);
    return conversation.streamMessages();
  }

  async getMessageStreamOfAllConversation() {
    const xmtp = await this.lazyInitClient();
    return await xmtp.conversations.streamAllMessages();
  }

  private async assertUserOnNetwork(to: string) {
    if (!await this.isOnNetwork(to, this.env)) {
      throw new Error(`${to} is not in network`);
    }
  }

  async isOnNetwork(address: string, network: XmtpEnv) {
    return Client.canMessage(address, {env: network})
  }

  private async _unlockKeys(value: any) {
    for (const key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const indexFileId = value[key].streamContent.file?.indexFileId;
        if (indexFileId) {
          const unlocked = await this.runtimeConnector.unlock({ indexFileId });
          console.log("_unlockKeys: ", unlocked.streamContent.content);
          const streamContent = unlocked.streamContent.content as {
            keys: string;
            encrypted: string;
          };
          return streamContent.keys;
        } else {
          return value[key].streamContent.content.keys;
        }
      }
    }
    throw new Error("cannot get pgp key from folder");
  }

  private async _persistMessage(message: DecodedMessage){

    const encrypted = JSON.stringify({
      content: true,
    });

    const streamContent = {
      sender_address: message.senderAddress,
      recipient_address: message.recipienAddress?? "",
      content: message.content,
      content_topic: message.contentTopic,
      content_type: JSON.stringify(message.contentType),
      message_id: message.id,
      message_version: message.messageVersion,
      created_at: message.send,
      encrypted: encrypted,
    }

    const res = await this.runtimeConnector.createStream({
      modelId: this.modelIds.message,
      streamContent: streamContent,
    });

    console.log("create stream return : ", res);
  }

  private async _persistKeys(keys: Uint8Array) {
    const keysStr = uint8ArrayToString(keys);
    const encrypted = JSON.stringify({
      keys: true,
    });

    const streamContent = {
      keys: keysStr,
      encrypted: encrypted
    }
    const res = await this.runtimeConnector.createStream({
      modelId: this.modelIds.keys_cache,
      streamContent: streamContent,
    });
    console.log("create key cache : ", res);
  }

  private async _checkCache(modelId: string) {
    const pkh = await this.runtimeConnector.wallet.getCurrentPkh();
    console.log("pkh: ", pkh);
    const stream = await this.runtimeConnector.loadStreamsBy({
      modelId: modelId,
      pkh: pkh,
    });
    if (Object.keys(stream).length == 0) {
      return { exist: false, value: null };
    } else {
      return { exist: true, value: stream };
    }
  }
}
