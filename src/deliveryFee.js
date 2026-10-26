/**
 * Delivery fee rules — one place, used by checkout, the fee quote and the
 * admin settlement breakdown so all three always agree.
 *
 *  - $4.99 base for any delivery within 5 km of the store.
 *  - $0.50 for every kilometre (started) beyond that.
 *  - Capped at $8.00 (MAX_DELIVERY_FEE_USD), however far the trip.
 *
 * Split (see computeCourierDeliveryPayoutUsd in orderPaymentSplit.js): DOT
 * keeps 20% of the fee, floored to the cent, and the courier gets the rest.
 * On the $4.99 base that is exactly $0.99 to DOT and $4.00 to the courier;
 * at the $8.00 cap it is $1.60 to DOT and $6.40 to the courier.
 */

import { computeCourierDeliveryPayoutUsd, getDeliveryPlatformCutRate } from './orderPaymentSplit.js';

export const DELIVERY_BASE_FEE_USD = 4.99;
export const DELIVERY_BASE_KM = 5;
export const DELIVERY_PER_KM_USD = 0.5;

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

// How far a store delivers. A merchant may set a tighter radius than the
// limit (e.g. "only 5 km out" for hot food); no store delivers beyond it.
export const DEFAULT_DELIVERY_RADIUS_KM = 15;
export const MAX_DELIVERY_RADIUS_KM = 15;

/** The distance (km) this store will actually deliver to. */
export function storeDeliveryRadiusKm(store) {
  const merchantRadiusKm = Number(store?.delivery_radius_km) || DEFAULT_DELIVERY_RADIUS_KM;
  return Math.min(merchantRadiusKm, MAX_DELIVERY_RADIUS_KM);
}

/** Most a customer is ever charged for delivery (default $8). */
export function getMaxDeliveryFeeUsd() {
  const raw = process.env.MAX_DELIVERY_FEE_USD;
  const n = raw != null && raw !== '' ? parseFloat(String(raw)) : 8;
  if (!Number.isFinite(n) || n < DELIVERY_BASE_FEE_USD) return 8;
  return money(n);
}

function deg2rad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** How the fee for a trip of this length is built, step by step. */
export function deliveryFeeQuote(distanceKm) {
  const d = Math.max(0, Number(distanceKm) || 0);
  const extraKm = d <= DELIVERY_BASE_KM ? 0 : Math.ceil(d - DELIVERY_BASE_KM);
  const distanceCharge = money(extraKm * DELIVERY_PER_KM_USD);
  const uncappedFee = money(DELIVERY_BASE_FEE_USD + distanceCharge);
  const cap = getMaxDeliveryFeeUsd();
  const fee = Math.min(uncappedFee, cap);
  return {
    distance_km: Math.round(d * 10) / 10,
    base_fee: DELIVERY_BASE_FEE_USD,
    base_km: DELIVERY_BASE_KM,
    per_km: DELIVERY_PER_KM_USD,
    extra_km: extraKm,
    distance_charge: distanceCharge,
    uncapped_fee: uncappedFee,
    cap,
    capped: uncappedFee > cap,
    fee,
  };
}

export function calculateDeliveryFee(distanceKm) {
  return deliveryFeeQuote(distanceKm).fee;
}

/**
 * The delivery fee an order was actually charged, explained for the
 * accountant: where the number came from and where every cent of it goes.
 *
 * The stored `delivery_fee` is the truth. The trip is re-measured from the
 * order's coordinates only to explain that number; when today's rules would
 * price it differently (an order from before the cap, say) the breakdown
 * says so instead of quietly showing a different figure.
 */
export function deliveryBreakdownForOrder(order) {
  const fee = money(order.delivery_fee);
  const coords = [order.pickup_latitude, order.pickup_longitude, order.delivery_latitude, order.delivery_longitude]
    .map((v) => (v == null ? NaN : Number(v)));
  const quote = coords.every(Number.isFinite)
    ? deliveryFeeQuote(haversineKm(coords[0], coords[1], coords[2], coords[3]))
    : null;

  // Base and distance parts of what was charged, taken from the charged fee
  // itself so they always add up to it. If the cap applied, distance_charged
  // is what was left of the distance charge after the cap.
  const baseCharged = money(Math.min(fee, DELIVERY_BASE_FEE_USD));
  const distanceCharged = money(fee - baseCharged);

  const courierShare = computeCourierDeliveryPayoutUsd(fee);
  const dotCut = money(fee - courierShare);
  const dotCutOnBase = money(DELIVERY_BASE_FEE_USD - computeCourierDeliveryPayoutUsd(DELIVERY_BASE_FEE_USD));
  const dotCutRate = getDeliveryPlatformCutRate();

  const customerDeliveryFee = money(order.customer_delivery_fee ?? fee);
  const promoSubsidy = money(order.dot_delivery_subsidy);

  return {
    fee_charged: fee,
    distance_km: quote ? quote.distance_km : null,
    base_fee: baseCharged,
    base_km: DELIVERY_BASE_KM,
    per_km: DELIVERY_PER_KM_USD,
    extra_km: quote ? quote.extra_km : null,
    distance_charge: distanceCharged,
    uncapped_fee: quote ? quote.uncapped_fee : null,
    cap: getMaxDeliveryFeeUsd(),
    capped: !!quote && quote.capped && fee === quote.fee,
    // What the cap saved the customer on this trip (0 when it didn't apply).
    cap_saving: quote && quote.capped && fee === quote.fee ? money(quote.uncapped_fee - fee) : 0,
    priced_by_current_rules: quote ? quote.fee === fee : null,
    current_rules_fee: quote ? quote.fee : null,

    // Who paid it.
    customer_paid: customerDeliveryFee,
    promo_subsidy: promoSubsidy,

    // Where it goes.
    dot_cut_rate: dotCutRate,
    courier_rate: money(1 - dotCutRate),
    courier_share: courierShare,
    dot_cut: dotCut,
    // DOT's cut split into "the $0.99 on the base" and "20% of the distance part".
    dot_cut_on_base: fee >= DELIVERY_BASE_FEE_USD ? dotCutOnBase : dotCut,
    dot_cut_on_distance: fee >= DELIVERY_BASE_FEE_USD ? money(dotCut - dotCutOnBase) : 0,
  };
}
