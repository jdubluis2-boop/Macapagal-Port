import RefundRequest from '../../../../components/RefundRequest';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <RefundRequest ticketId={id}/>;}
