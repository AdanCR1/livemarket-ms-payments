import { Hono } from 'hono';
import { z } from 'zod';
import { auth } from '../middleware/auth';
import { createSupabaseAdmin } from '../utils/supabase';
import type { AppContext } from '../types';

const routes=new Hono<AppContext>();
const uuid=z.string().uuid();

// Una cuenta solo puede consultar o modificar su propio pedido/custodia.
async function ownedEscrow(c:any,orderId:string){
 const actor=c.get('actor');
 const db=createSupabaseAdmin(c.env);
 const {data,error}=await db.from('escrow_settlements').select('*').eq('order_id',orderId).maybeSingle();
 if(error||!data) return null;
 const owner=(actor.role==='B2C'&&data.customer_id===actor.id) ||
   (actor.role==='B2B'&&actor.storeId&&data.store_id===actor.storeId);
 return owner?data:null;
}

routes.post('/bind-qr',auth,c=>c.json({
 success:false,error:'La asociación de destinos requiere una cuenta bancaria verificada e inmutable'
},503));

routes.get('/detail/:order_id',auth,async c=>{
 if(!uuid.safeParse(c.req.param('order_id')).success)return c.json({success:false,error:'ID inválido'},400);
 const escrow=await ownedEscrow(c,c.req.param('order_id'));
 if(!escrow)return c.json({success:false,error:'Custodia no encontrada'},404);
 // Excluir información bancaria interna si se añaden campos a futuro.
 const {id,order_id,status,amount,currency,release_due_at,seller_qr_image_url,buyer_qr_image_url,created_at}=escrow;
 return c.json({success:true,data:{id,order_id,status,amount,currency,release_due_at,seller_qr_image_url,buyer_qr_image_url,created_at}});
});

routes.post('/settle',auth,c=>c.json({
 success:false,error:'Las sesiones de usuario no pueden liquidar ni reembolsar custodia'
},403));
export default routes;
