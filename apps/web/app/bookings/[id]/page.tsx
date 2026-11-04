import BookingView from '../../../components/BookingView';
export default async function Page({params}:{params:Promise<{id:string}>}){const {id}=await params;return <BookingView id={id}/>;}
