import { ClobClient, OrderType, Side, SignatureType } from '@polymarket/clob-client';
import { Wallet, TypedDataDomain, TypedDataField } from 'ethers';

const CLOB_HOST         = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID  = 137;

export interface ClobCredentials {
  privateKey: string;
  apiKey: string;
  apiSecret: string;
  apiPassphrase: string;
  signatureType: '0' | '1' | '2';
  funder?: string;
}

export interface PlaceOrderParams {
  tokenId: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
}

export interface OrderResult {
  orderId: string;
  status: string;
  success: boolean;
  errorMsg?: string;
}

function toSignatureType(raw: '0' | '1' | '2'): SignatureType {
  const map: Record<string, SignatureType> = {
    '0': SignatureType.EOA,
    '1': SignatureType.POLY_PROXY,
    '2': SignatureType.POLY_GNOSIS_SAFE,
  };
  return map[raw] ?? SignatureType.EOA;
}

function makeEthersSigner(wallet: Wallet) {
  return {
    getAddress: () => wallet.getAddress(),
    _signTypedData: (
      domain: TypedDataDomain,
      types: Record<string, TypedDataField[]>,
      value: Record<string, unknown>
    ) => wallet.signTypedData(domain, types, value),
  };
}

export class ClobOrderClient {
  private client: ClobClient | null = null;
  private ready = false;

  async init(creds: ClobCredentials): Promise<void> {
    if (!creds.privateKey.startsWith('0x') || creds.privateKey.length !== 66) {
      throw new Error('PRIVATE_KEY must be a 32-byte hex string prefixed with 0x (66 chars total).');
    }
    if (!creds.apiKey || !creds.apiSecret || !creds.apiPassphrase) {
      throw new Error(
        'POLYMARKET_API_KEY, POLYMARKET_API_SECRET, and POLYMARKET_API_PASSPHRASE are all required for live trading.'
      );
    }

    const wallet = new Wallet(creds.privateKey);
    const signer = makeEthersSigner(wallet);

    this.client = new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID,
      signer,
      {
        key:        creds.apiKey,
        secret:     creds.apiSecret,
        passphrase: creds.apiPassphrase,
      },
      toSignatureType(creds.signatureType),
      creds.funder
    );

    await this.client.getOk();
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    if (!this.client || !this.ready) {
      throw new Error('ClobOrderClient is not initialized. Call init() first.');
    }

    const userOrder = {
      tokenID: params.tokenId,
      price:   params.price,
      size:    params.size,
      side:    params.side === 'buy' ? Side.BUY : Side.SELL,
    };

    const signedOrder = await this.client.createOrder(userOrder);
    const response    = await this.client.postOrder(signedOrder, OrderType.GTC);

    return {
      orderId:  response.orderID  ?? '',
      status:   response.status   ?? 'unknown',
      success:  response.success  ?? false,
      errorMsg: response.errorMsg ?? undefined,
    };
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (!this.client || !this.ready) {
      throw new Error('ClobOrderClient is not initialized.');
    }
    await this.client.cancelOrder({ orderID: orderId });
  }

  async cancelAll(): Promise<void> {
    if (!this.client || !this.ready) {
      throw new Error('ClobOrderClient is not initialized.');
    }
    await this.client.cancelAll();
  }

  async getOpenOrders(): Promise<unknown[]> {
    if (!this.client || !this.ready) {
      throw new Error('ClobOrderClient is not initialized.');
    }
    const result = await this.client.getOpenOrders();
    return Array.isArray(result) ? result : [];
  }
}
