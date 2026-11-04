import {config} from './config.js';
/** Optional Twilio adapter. The default path explicitly reports no SMS delivery. */
export async function sendSms(to:string,message:string):Promise<{status:string;providerReference?:string}>{
 if(config.SMS_PROVIDER==='disabled')return{status:'UNCONFIGURED'};
 if(!/^\+639\d{9}$/.test(to))return{status:'SKIPPED_NO_VALID_MOBILE'};
 if(!config.TWILIO_ACCOUNT_SID||!config.TWILIO_AUTH_TOKEN||!config.TWILIO_FROM_NUMBER)throw new Error('SMS credentials are not configured');
 const response=await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_ACCOUNT_SID}/Messages.json`,{
  method:'POST',headers:{authorization:`Basic ${Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64')}`,'content-type':'application/x-www-form-urlencoded'},
  body:new URLSearchParams({To:to,From:config.TWILIO_FROM_NUMBER,Body:message}),signal:AbortSignal.timeout(10000),
 });
 if(!response.ok)throw new Error('SMS provider temporarily unavailable');
 const result=await response.json()as{sid?:string};
 // Accepted by a provider is not proof of handset delivery.
 return{status:'PROVIDER_ACCEPTED',providerReference:result.sid};
}
