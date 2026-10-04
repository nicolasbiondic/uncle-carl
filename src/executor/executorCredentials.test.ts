// ═══ F4a — executor credential injection + env-mode identity ═══
//
// Two contracts locked here:
//  1. ENV MODE (no credentials option — today's only prod configuration):
//     every effective credential value (SDK options, raw-fetch headers,
//     URLs, paper flag) is EXACTLY config.*, read LIVE — mutating config
//     after construction is still visible (the test seams the existing
//     suites rely on). Byte-identical behavior, locked.
//  2. INJECTION (ACCOUNTS_SOURCE=registry): the injected credentials are
//     the ONLY source — config/.env values never leak in; OAuth switches
//     the raw-fetch auth to Authorization: Bearer and the SDK to `oauth`.

import { describe, expect, test, afterEach } from "bun:test";
import { config } from "../config";
import { AlpacaExecutor } from "./alpaca-executor";
import { BinanceExecutor } from "./binance-executor";
import { OrderExecutor } from "./order-executor";
import { unlinkedAlpacaCredentials, unlinkedBinanceCredentials, alpacaRuntimeAuthHeaders } from "./credentials";

const alpacaCfg = config.alpaca as any;
const saved = { ...config.alpaca };
afterEach(() => { Object.assign(alpacaCfg, saved); });

const REGISTRY_ALPACA = {
  keyId: "REGKEY", secretKey: "REGSECRET", oauthToken: null as string | null,
  paper: true, baseUrl: "https://paper-api.alpaca.markets",
  dataUrl: "https://data.alpaca.markets", accountId: "alpaca-paper",
};

describe("AlpacaExecutor — env mode is byte-identical (live config reads)", () => {
  test("accessors mirror config.alpaca.* LIVE, including post-construction mutation", () => {
    const exec = new AlpacaExecutor() as any;
    expect(exec.keyId).toBe(config.alpaca.keyId);
    expect(exec.secretKey).toBe(config.alpaca.secretKey);
    expect(exec.paper).toBe(config.alpaca.paper);
    expect(exec.baseUrl).toBe(config.alpaca.baseUrl);
    expect(exec.dataUrl).toBe(config.alpaca.dataUrl);
    expect(exec.oauthToken).toBeNull();
    // The existing test seam: suites mutate config at runtime and the
    // executor must follow (no capture at construction).
    alpacaCfg.keyId = "MUTATED";
    alpacaCfg.dataUrl = "https://mutated.example";
    expect(exec.keyId).toBe("MUTATED");
    expect(exec.dataUrl).toBe("https://mutated.example");
    expect(exec.authHeaders).toEqual({
      "APCA-API-KEY-ID": "MUTATED",
      "APCA-API-SECRET-KEY": config.alpaca.secretKey,
    });
  });

  test("SDK client is constructed with the exact config values (as always)", () => {
    const exec = new AlpacaExecutor() as any;
    expect(exec.client.configuration.keyId).toBe(config.alpaca.keyId);
    expect(exec.client.configuration.secretKey).toBe(config.alpaca.secretKey);
    expect(exec.client.configuration.baseUrl).toBe(config.alpaca.baseUrl);
  });
});

describe("AlpacaExecutor — injected registry credentials are the ONLY source", () => {
  test("api_key injection: accessors + headers from the injection; config mutation invisible", () => {
    const exec = new AlpacaExecutor({ credentials: { ...REGISTRY_ALPACA } }) as any;
    alpacaCfg.keyId = "ENVKEY-MUST-NOT-LEAK";
    expect(exec.keyId).toBe("REGKEY");
    expect(exec.secretKey).toBe("REGSECRET");
    expect(exec.paper).toBe(true);
    expect(exec.authHeaders).toEqual({ "APCA-API-KEY-ID": "REGKEY", "APCA-API-SECRET-KEY": "REGSECRET" });
    expect(exec.client.configuration.keyId).toBe("REGKEY");
    expect(exec.credentialPublicView()).toEqual({ keyId: "REGKEY", paper: true, authType: "api_key" });
  });

  test("oauth injection: Bearer header + SDK `oauth` option", () => {
    const exec = new AlpacaExecutor({
      credentials: { ...REGISTRY_ALPACA, keyId: "", secretKey: "", oauthToken: "tok-abc" },
    }) as any;
    expect(exec.authHeaders).toEqual({ Authorization: "Bearer tok-abc" });
    expect(exec.client.configuration.oauth).toBe("tok-abc");
    expect(exec.credentialPublicView().authType).toBe("oauth");
  });

  test("unlinked credentials: empty keys — init() refuses without network, .env never consulted", async () => {
    const exec = new AlpacaExecutor({ credentials: unlinkedAlpacaCredentials() }) as any;
    alpacaCfg.keyId = "ENVKEY";
    alpacaCfg.secretKey = "ENVSECRET";
    expect(exec.keyId).toBe("");
    expect(await (exec as AlpacaExecutor).init()).toBe(false); // "keys not configured" path
    expect(exec.connected).toBe(false);
  });
});

describe("BinanceExecutor — credential injection", () => {
  test("env mode: fields captured from config exactly as before", () => {
    const exec = new BinanceExecutor() as any;
    expect(exec.apiKey).toBe(config.binanceFutures.apiKey || config.binance.apiKey);
    expect(exec.secretKey).toBe(config.binanceFutures.apiSecret || config.binance.apiSecret);
    expect(exec.baseUrl).toBe(config.binanceFutures.restBase || "https://demo-fapi.binance.com");
  });

  test("injected registry credentials are the only source", () => {
    const exec = new BinanceExecutor({
      credentials: { apiKey: "RBK", apiSecret: "RBS", restBase: "https://demo-fapi.binance.com", accountId: "binance-demo" },
    }) as any;
    expect(exec.apiKey).toBe("RBK");
    expect(exec.secretKey).toBe("RBS");
    expect(exec.baseUrl).toBe("https://demo-fapi.binance.com");
    expect(exec.credentialPublicView()).toEqual({ apiKey: "RBK", restBase: "https://demo-fapi.binance.com" });
  });

  test("unlinked credentials: init() refuses (keys not configured), no network", async () => {
    const exec = new BinanceExecutor({ credentials: unlinkedBinanceCredentials() });
    expect(await exec.init()).toBe(false);
    expect(exec.isConnected()).toBe(false);
  });
});

describe("OrderExecutor — options pass through to both executors", () => {
  test("no options = env mode on both (today's construction)", () => {
    const oe = new OrderExecutor();
    expect((oe.alpaca as any).creds).toBeNull();
    expect((oe.binance as any).apiKey).toBe(config.binanceFutures.apiKey || config.binance.apiKey);
  });
  test("registry options reach the right executors", () => {
    const oe = new OrderExecutor({
      alpacaCredentials: { ...REGISTRY_ALPACA },
      binanceCredentials: { apiKey: "RBK", apiSecret: "RBS", restBase: "https://demo-fapi.binance.com", accountId: "b" },
    });
    expect((oe.alpaca as any).keyId).toBe("REGKEY");
    expect((oe.binance as any).apiKey).toBe("RBK");
  });
});

describe("alpacaRuntimeAuthHeaders — helper used by the data-path injections", () => {
  test("APCA pair for api_key, Bearer for oauth", () => {
    expect(alpacaRuntimeAuthHeaders({ ...REGISTRY_ALPACA })).toEqual({
      "APCA-API-KEY-ID": "REGKEY", "APCA-API-SECRET-KEY": "REGSECRET",
    });
    expect(alpacaRuntimeAuthHeaders({ ...REGISTRY_ALPACA, oauthToken: "t" })).toEqual({ Authorization: "Bearer t" });
  });
});
