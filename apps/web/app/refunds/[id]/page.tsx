import RefundView from '../../../components/RefundView';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <RefundView id={id}/>;}
