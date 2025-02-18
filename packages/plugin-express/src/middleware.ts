import type * as express from "express";

import {
  type IdempotencyPluginOptions,
  buildStorageAdapter,
  headers2Cache,
  HTTPHeaderEnum,
  idempotency2HttpCodeMap,
} from "@node-idempotency/shared";
import {
  Idempotency,
  IdempotencyError,
  type IdempotencyParams,
  type IdempotencyResponse,
  IdempotencyErrorCodes,
} from "@node-idempotency/core";
import { type ExpressMiddleware } from "./types";

const getIdempotencyInstance = async (
  options: IdempotencyPluginOptions,
): Promise<Idempotency> => {
  const storageAdapter = await buildStorageAdapter(options.storage);
  return new Idempotency(storageAdapter, options);
};

const setHeaders = (
  response: express.Response,
  headers: Record<string, string>,
): void => {
  Object.keys(headers).forEach((key) => {
    if (headers[key]) {
      void response.header(key, headers[key]);
    }
  });
};

const handleResponse = async (
  idempotencyReq: IdempotencyParams,
  nodeIdempotency: Idempotency,
  response: express.Response,
  payload?: string | Record<string, unknown>,
): Promise<void> => {
  const { statusCode } = response;
  const headers = response.getHeaders();
  const additional = { statusCode };
  Object.values(headers2Cache).forEach((header) => {
    const head = headers[header] ?? headers[header.toLowerCase()];
    if (head) {
      additional[header] = head;
    }
  });
  try {
    const isJson = (headers["content-type"] ?? headers["Content-Type"])
      ?.toString()
      ?.toLowerCase()
      ?.includes("application/json");
    if (isJson && typeof payload === "string") {
      payload = JSON.parse(payload);
    }
  } catch {
    // ignore the error
  }
  const res: IdempotencyResponse = {
    additional,
    ...(statusCode < 400 ? { body: payload } : { error: payload }),
  };
  await nodeIdempotency.onResponse(idempotencyReq, res);
};

const successHandler = (nodeIdempotency: Idempotency): ExpressMiddleware => {
  return async (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ): Promise<void> => {
    const idempotencyReq: IdempotencyParams = {
      headers: request.headers,
      body: request.body as Record<string, unknown>,
      path: request.url,
      method: request.method,
      original_req: request,
    };
    try {
      const idempotencyResponse: IdempotencyResponse | undefined =
        await nodeIdempotency.onRequest<unknown, Error>(idempotencyReq);
      if (!idempotencyResponse) {
        // fist time request, itercept and cache the response
        const originalSend: express.Send = response.send.bind(response);
        response.send = function (body?: any): express.Response {
          void handleResponse(
            idempotencyReq,
            nodeIdempotency,
            response,
            body as string,
          );
          return originalSend(body);
        };
        next();
        return;
      }
      // this is a duplicate request
      if (idempotencyResponse.additional?.statusCode) {
        const { statusCode } = idempotencyResponse.additional;
        void response.status(statusCode as number);
      }
      const headers = Object.values(headers2Cache).reduce<
        Record<string, string>
      >((res, cur) => {
        if (idempotencyResponse?.additional?.[cur]) {
          res[cur] = idempotencyResponse.additional[cur] as string;
        }
        return res;
      }, {});
      setHeaders(response, {
        ...headers,
        [HTTPHeaderEnum.idempotentReplayed]: "true",
      });
      if (idempotencyResponse.body) {
        response.send(idempotencyResponse.body);
      } else {
        next(idempotencyResponse.error);
      }
    } catch (err) {
      if (err instanceof IdempotencyError) {
        const status = idempotency2HttpCodeMap[err.code] || 500;
        if (err.code === IdempotencyErrorCodes.REQUEST_IN_PROGRESS) {
          setHeaders(response, { [HTTPHeaderEnum.retryAfter]: "1" });
        }
        void response.status(status);
        next(err);
      }
    }
  };
};

export const idempotencyAsMiddleware = async (
  options: IdempotencyPluginOptions,
): Promise<ExpressMiddleware[]> => {
  const idempotency = await getIdempotencyInstance(options);
  return [successHandler(idempotency)];
};
