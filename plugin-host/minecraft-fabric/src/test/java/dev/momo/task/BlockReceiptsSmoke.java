package dev.momo.task;
public final class BlockReceiptsSmoke {
 public static void main(String[] args){
  BlockReceipts receipts=new BlockReceipts();Object world=new Object();long accepted=receipts.cursor();
  if(receipts.after(world,1,64,2,accepted)!=null)throw new AssertionError("client prediction is not a server receipt");
  receipts.record(world,1,64,2,"minecraft:air","air");
  if(receipts.after(world,1,64,2,accepted)==null)throw new AssertionError("matching server block fact must be available");
  if(receipts.after(world,2,64,2,accepted)!=null)throw new AssertionError("another block cannot prove this action");
  if(receipts.after(world,1,64,2,receipts.cursor())!=null)throw new AssertionError("old packet cannot confirm a new task");
  receipts.changeWorld(null);
  if(receipts.after(world,1,64,2,accepted)!=null)throw new AssertionError("old world must be released");
  System.out.println("PASS server block receipt position, world and action boundary");
 }
}
