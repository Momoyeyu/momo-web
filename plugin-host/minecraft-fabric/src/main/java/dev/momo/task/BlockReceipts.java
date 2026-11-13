package dev.momo.task;
import java.util.LinkedHashMap;
/** Bounded server facts, game-thread only. Predicted client changes never enter here. */
public final class BlockReceipts {
 public static final BlockReceipts CURRENT=new BlockReceipts();
 private record Position(int x,int y,int z){}
 public record Receipt(long seq,String block,String state){}
 private Object world;private long sequence;
 private final LinkedHashMap<Position,Receipt> recent=new LinkedHashMap<>();
 public long cursor(){return sequence;}
 public void changeWorld(Object value){if(world!=value){recent.clear();world=value;}}
 public void record(Object value,int x,int y,int z,String block,String state){
  if(value==null)return;changeWorld(value);var pos=new Position(x,y,z);
  recent.remove(pos);recent.put(pos,new Receipt(++sequence,block,state));
  while(recent.size()>2048)recent.remove(recent.keySet().iterator().next());
 }
 public Receipt after(Object value,int x,int y,int z,long accepted){
  if(world!=value)return null;var receipt=recent.get(new Position(x,y,z));return receipt!=null&&receipt.seq>accepted?receipt:null;
 }
}
