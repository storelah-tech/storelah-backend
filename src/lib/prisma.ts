import { PrismaClient } from '@prisma/client';
import { assertDataInScope, currentBranchScope, isScopedModel, scopeWhere, withScope } from './facilityScope';

// Operations whose `where` gets the facility filter; creates are checked.
const FILTERED = new Set([
  'findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy',
  'update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany', 'upsert',
]);
const CREATES = new Set(['create', 'createMany', 'createManyAndReturn']);

function createClient() {
  // Facility scope (CMS RBAC): inside a scoped CMS request every query on a
  // facility-linked model is limited to the operator's facilities — see
  // lib/facilityScope.ts. Outside one (public/customer API, scripts, tests)
  // this is a pass-through.
  return new PrismaClient().$extends({
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const branchIds = currentBranchScope();
          if (!branchIds || !isScopedModel(model)) return query(args);
          const a = (args ?? {}) as Record<string, any>;
          if (FILTERED.has(operation)) {
            a.where = withScope(a.where, scopeWhere(model, branchIds)!);
            if (operation === 'upsert') {
              assertDataInScope(model, a.create, branchIds, true);
              assertDataInScope(model, a.update, branchIds, false);
            } else if (a.data !== undefined) {
              assertDataInScope(model, a.data, branchIds, false);
            }
          } else if (CREATES.has(operation)) {
            assertDataInScope(model, a.data, branchIds, true);
          }
          return query(a);
        },
      },
    },
  });
}

// Typed as the plain client: a query-only extension leaves the API unchanged,
// and the many `Prisma.TransactionClient` parameters keep compiling.
const globalForPrisma = global as unknown as { prisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.prisma ?? (createClient() as unknown as PrismaClient);

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
