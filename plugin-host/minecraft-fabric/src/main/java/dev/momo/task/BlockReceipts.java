package dev.momo.task;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.function.LongSupplier;
/** Bounded server facts, game-thread only. Predicted client changes never enter here. */
public final class BlockReceipts {
 public static final BlockReceipts CURRENT=new BlockReceipts();
 private record Position(int x,int y,int z){}
 private record Placement(String account,String block){}
 public record Receipt(long seq,String block,String state,long observedAt){}
 public record Fact(long seq,String source,long serverBlockSeq,long observedAt,String account,String dimension,int x,int y,int z,String block){}
 private Object world;private long sequence,factSequence;
 private final LongSupplier clock;
 private final LinkedHashMap<Position,Receipt> recent=new LinkedHashMap<>();
 private final LinkedHashMap<Position,Fact> known=new LinkedHashMap<>();
 private final LinkedHashMap<Position,Placement> placed=new LinkedHashMap<>();
 public BlockReceipts(){this(System::currentTimeMillis);}
 BlockReceipts(LongSupplier clock){this.clock=clock;}
 public long cursor(){return sequence;}
 public void changeWorld(Object value){if(world!=value){recent.clear();known.clear();placed.clear();world=value;}}
 public void record(Object value,int x,int y,int z,String block,String state){
  if(value==null)return;changeWorld(value);var pos=new Position(x,y,z);
  recent.remove(pos);recent.put(pos,new Receipt(++sequence,block,state,clock.getAsLong()));
  var placement=placed.get(pos);if(placement!=null&&!placement.block().equals(block))placed.remove(pos);
  while(recent.size()>2048)recent.remove(recent.keySet().iterator().next());
 }
 public Receipt after(Object value,int x,int y,int z,long accepted){
  if(world!=value)return null;var receipt=recent.get(new Position(x,y,z));return receipt!=null&&receipt.seq>accepted?receipt:null;
 }
 /** Caller proved that its own ordinary placement matched this latest server receipt. */
 public void claimPlacement(Object value,String account,int x,int y,int z,Receipt receipt){
  if(value==null||value!=world||account==null||account.isBlank()||receipt==null)return;
  var pos=new Position(x,y,z);if(recent.get(pos)!=receipt)return;
  placed.remove(pos);placed.put(pos,new Placement(account,receipt.block()));
  while(placed.size()>2048)placed.remove(placed.keySet().iterator().next());
 }
 /** Broad gather skips recent own construction; exact mine remains available. */
 public boolean protectsPlacement(Object value,String account,int x,int y,int z,String actualBlock){
  var placement=value==world?placed.get(new Position(x,y,z)):null;
  return placement!=null&&placement.account().equals(account)&&placement.block().equals(actualBlock);
 }
 public void claimMine(Object value,String account,String dimension,int x,int y,int z,long accepted,String before){
  var receipt=after(value,x,y,z,accepted);
  if(receipt==null||receipt.block().equals(before))return;
  remember(account,dimension,x,y,z,receipt.block(),"mined",receipt.seq(),receipt.observedAt());
 }
 /** Caller must first establish a clear sight ray and actual air, never intent. */
 public void observeAbsence(Object value,String account,String dimension,int x,int y,int z){
  if(value==null)return;changeWorld(value);
  remember(account,dimension,x,y,z,"minecraft:air","visible_absence",0,clock.getAsLong());
 }
 private void remember(String account,String dimension,int x,int y,int z,String block,String source,long server,long at){
  if(account==null||account.isBlank())return;
  var pos=new Position(x,y,z);var old=known.get(pos);
  if(old!=null&&old.account().equals(account)&&(old.observedAt()>at||old.observedAt()==at&&old.serverBlockSeq()==server&&old.source().equals(source)&&old.block().equals(block)))return;
  known.remove(pos);known.put(pos,new Fact(++factSequence,source,server,at,account,dimension,x,y,z,block));
  while(known.size()>128)known.remove(known.keySet().iterator().next());
 }
 /** A bounded projection of claimed results, not the surrounding server packets. */
 public List<Fact> facts(Object value,String account){return value==world&&account!=null?known.values().stream().filter(fact->account.equals(fact.account())).toList():List.of();}
}
