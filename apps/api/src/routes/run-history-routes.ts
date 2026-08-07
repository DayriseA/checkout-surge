import {
  adminDeleteRunHistoryRequestSchema,
  adminRunHistoryDetailHttpQuerySchema,
  adminRunHistoryDetailPathTemplate,
  adminRunHistoryDetailResponseSchema,
  publicRunHistoryDetailResponseSchema,
  runHistoryDetailParamsSchema,
  runHistoryDetailPathTemplate,
  runHistoryListQuerySchema,
  runHistoryPath,
} from "@checkout-surge/contracts";
import { replaceFastifyCorrelation } from "@checkout-surge/logger/fastify";
import { ApiHttpError } from "../runtime/errors.js";
import type { ApiFastifyInstance } from "../runtime/fastify.js";
import type { RunHistoryController } from "../services/run-history-service.js";
import { requireControlServiceToken } from "./control-service-token.js";

export interface RegisterRunHistoryRoutesOptions {
  runHistoryService: RunHistoryController;
  controlServiceToken: string;
}

export function registerRunHistoryRoutes(
  app: ApiFastifyInstance,
  options: RegisterRunHistoryRoutesOptions,
): void {
  app.get(runHistoryPath, async (request, reply) => {
    const query = runHistoryListQuerySchema.parse(request.query ?? {});
    return reply.status(200).send(await options.runHistoryService.list(query));
  });

  app.get(runHistoryDetailPathTemplate, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { runId } = runHistoryDetailParamsSchema.parse(request.params ?? {});
    const detail = await options.runHistoryService.detail(runId);

    if (!detail) {
      throw new ApiHttpError({
        statusCode: 404,
        code: "resource_not_found",
        message: "Run history detail was not found.",
        details: { runId },
      });
    }

    const response = publicRunHistoryDetailResponseSchema.safeParse(detail);
    if (!response.success) {
      throw new ApiHttpError({
        statusCode: 500,
        code: "internal_error",
        message: "Run history detail response was invalid.",
      });
    }
    return reply.status(200).send(response.data);
  });

  app.get(adminRunHistoryDetailPathTemplate, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) return unauthorized;
    const { runId } = runHistoryDetailParamsSchema.parse(request.params ?? {});
    const query = adminRunHistoryDetailHttpQuerySchema.parse(request.query ?? {});
    const detail = await options.runHistoryService.adminDetail(runId, query);
    if (!detail) {
      throw new ApiHttpError({
        statusCode: 404,
        code: "resource_not_found",
        message: "Run history detail was not found.",
        details: { runId },
      });
    }
    const response = adminRunHistoryDetailResponseSchema.safeParse(detail);
    if (!response.success) {
      throw new ApiHttpError({
        statusCode: 500,
        code: "internal_error",
        message: "Run history detail response was invalid.",
      });
    }
    return reply.status(200).send(response.data);
  });

  app.delete(runHistoryPath, async (request, reply) => {
    const unauthorized = requireControlServiceToken(request, reply, options.controlServiceToken);
    if (unauthorized) {
      return unauthorized;
    }

    const parsed = adminDeleteRunHistoryRequestSchema.parse(request.body ?? {});
    const correlationId = replaceFastifyCorrelation(
      request,
      reply,
      parsed.correlationId ?? request.correlationId,
    );

    return reply.status(200).send(await options.runHistoryService.delete(parsed, correlationId));
  });
}
