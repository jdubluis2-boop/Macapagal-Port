import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertBookingTransition} from '../src/state-machine.js';
import {encrypt,decrypt} from '../src/encryption.js';
import {refundMath} from '../src/refunds.js';
test('paid flow and refund flow accept only legitimate state transitions',()=>{
 for(const[from,to]of[['DRAFT','SEAT_HELD'],['SEAT_HELD','PAYMENT_PENDING'],['PAYMENT_PENDING','PAID'],['PAID','TICKET_ISSUED'],['TICKET_ISSUED','REFUND_REQUESTED'],['REFUND_REQUESTED','REFUND_PROCESSING'],['REFUND_PROCESSING','REFUNDED']]as const)assert.doesNotThrow(()=>assertBookingTransition(from,to));
 for(const[from,to]of[['DRAFT','PAID'],['REFUNDED','TICKET_ISSUED'],['COMPLETED','REFUND_REQUESTED'],['PAYMENT_PENDING','SEAT_HELD']]as const)assert.throws(()=>assertBookingTransition(from,to));
});
test('AES-GCM encryption uses unique nonces, round-trips, and rejects tampering',()=>{
 const person={fullName:'Maria Example',mobile:'+639123456789'};
 const one=encrypt(person),two=encrypt(person);assert.notEqual(one,two);assert.ok(!one.includes(person.fullName));assert.deepEqual(decrypt(one),person);
 const parts=one.split('.');const b=Buffer.from(parts[3],'base64url');b[0]^=1;parts[3]=b.toString('base64url');assert.throws(()=>decrypt(parts.join('.')));
});
test('refund arithmetic uses centavos and includes terminal fee in the policy basis once',()=>{
 assert.deepEqual(refundMath(48000,2000),{totalCentavos:48000,deductionCentavos:9600,refundCentavos:38400});
 assert.deepEqual(refundMath(48000,0),{totalCentavos:48000,deductionCentavos:0,refundCentavos:48000});
});
