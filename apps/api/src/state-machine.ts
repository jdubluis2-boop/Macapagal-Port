import type { BookingStatus } from '@prisma/client';
// Internal stages PAID and REFUND_REQUESTED are persisted in the same transaction
// as their next stage where appropriate, so clients never infer a provider result.
const transitions:Record<BookingStatus,readonly BookingStatus[]>={
 DRAFT:['SEAT_HELD','CANCELLED'],SEAT_HELD:['PAYMENT_PENDING','COUNTER_PENDING','HOLD_EXPIRED','CANCELLED'],
 PAYMENT_PENDING:['PAID','PAYMENT_FAILED','HOLD_EXPIRED','CANCELLED'],PAYMENT_FAILED:['SEAT_HELD','PAYMENT_PENDING','COUNTER_PENDING','HOLD_EXPIRED','PAID','CANCELLED'],
 HOLD_EXPIRED:['SEAT_HELD','PAID','CANCELLED'],COUNTER_PENDING:['PAID','EXPIRED_UNPAID','CANCELLED'],EXPIRED_UNPAID:[],
 PAID:['TICKET_ISSUED','REFUND_REQUESTED'],TICKET_ISSUED:['COMPLETED','REFUND_REQUESTED'],COMPLETED:[],
 REFUND_REQUESTED:['REFUND_PROCESSING'],REFUND_PROCESSING:['REFUNDED'],REFUNDED:[],CANCELLED:['REFUND_REQUESTED'],
};
export function assertBookingTransition(from:BookingStatus,to:BookingStatus):void{
 if(from===to)return;
 if(!transitions[from].includes(to))throw Object.assign(new Error(`Illegal booking transition ${from} → ${to}`),{statusCode:409});
}
