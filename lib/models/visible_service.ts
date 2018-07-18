/**
 * Represents a VisibleService entity used to cache a list of
 * services, taken from CosmosDB, that have is_visible flag set to true.
 */
import * as t from "io-ts";

import { collect, StrMap } from "fp-ts/lib/StrMap";
import { NonEmptyString } from "italia-ts-commons/lib/strings";
import { OrganizationFiscalCode } from "../api/definitions/OrganizationFiscalCode";
import { ServiceId } from "../api/definitions/ServiceId";

// this is not a CosmosDB model, but entities are stored into blob storage
export const VISIBLE_SERVICE_CONTAINER = "cached";
export const VISIBLE_SERVICE_BLOB_ID = "visible-services.json";

export const VisibleService = t.type({
  departmentName: NonEmptyString,
  id: NonEmptyString,
  organizationFiscalCode: OrganizationFiscalCode,
  organizationName: NonEmptyString,
  serviceId: ServiceId,
  serviceName: NonEmptyString,
  version: t.Integer
});
export type VisibleService = t.TypeOf<typeof VisibleService>;

export const ApiVisibleService = t.type({
  department_name: NonEmptyString,
  id: NonEmptyString,
  organization_fiscal_code: OrganizationFiscalCode,
  organization_name: NonEmptyString,
  service_id: ServiceId,
  service_name: NonEmptyString,
  version: t.Integer
});
export type ApiVisibleService = t.TypeOf<typeof ApiVisibleService>;

export function toVisibleServiceApi(
  visibleService: VisibleService
): ApiVisibleService {
  return {
    department_name: visibleService.departmentName,
    id: visibleService.id,
    organization_fiscal_code: visibleService.organizationFiscalCode,
    organization_name: visibleService.organizationName,
    service_id: visibleService.serviceId,
    service_name: visibleService.serviceName,
    version: visibleService.version
  };
}

export function toVisibleServicesApi(
  visibleServices: StrMap<VisibleService>
): ReadonlyArray<ApiVisibleService> {
  return collect(visibleServices, (_, v) => toVisibleServiceApi(v));
}