import { dahitiKey } from "../adapters/dahiti-guri/key.ts";
import { firmsMapKey } from "../adapters/firms-fires/key.ts";
import { anthropicKey, typesafeKey } from "../ai/key.ts";
import type { KeySpec } from "./keyspec.ts";

/** Every key Vigía can use. The guide is generated from this list. */
export const KEY_SPECS: readonly KeySpec[] = [firmsMapKey, dahitiKey, typesafeKey, anthropicKey];
