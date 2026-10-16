/**
 * A learned categorization rule (Phase B). Created when Malike corrects a
 * payee/category or taps "Always do this for [merchant]". Applied before
 * history and built-ins on future imports.
 */
export interface MerchantRule {
  id: string;
  merchantKey: string;
  categoryId: string;
  payeeName: string;
  createdAt: string;
  updatedAt: string;
}
