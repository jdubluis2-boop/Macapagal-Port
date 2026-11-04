import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registration, mobile, password } from '../src/validation.js';
const valid = { fullName:'Maria Santos', email:'Maria@example.com', mobile:'+63 912 345 6789', password:'safePassword1', confirmPassword:'safePassword1', consent:true };
test('registration normalizes email and Philippine mobile', () => {const r=registration.parse(valid);assert.equal(r.email,'maria@example.com');assert.equal(r.mobile,'+639123456789');});
test('registration requires consent and matching passwords', () => {assert.equal(registration.safeParse({...valid,consent:false}).success,false);assert.equal(registration.safeParse({...valid,confirmPassword:'different'}).success,false);});
test('password rejects missing number, short and oversized input', () => {for(const p of ['password','abc1','a'.repeat(128)+'1'])assert.equal(password.safeParse(p).success,false);});
test('mobile rejects non-PH and malformed numbers', () => {for(const p of ['09123456789','+639123','+14155552671'])assert.equal(mobile.safeParse(p).success,false);});
