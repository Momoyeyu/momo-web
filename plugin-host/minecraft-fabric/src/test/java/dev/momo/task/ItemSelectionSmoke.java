package dev.momo.task;
import java.util.List;
public final class ItemSelectionSmoke {
 private static void check(boolean value,String why){if(!value)throw new AssertionError(why);}
 public static void main(String[] args){
  var pack=ItemSelection.choose(List.of(9),-1,0).orElseThrow();
  check(pack.screenSlot()==9&&pack.hotbar()==0&&pack.swap(),"a backpack item must use a verified hotbar swap, never player crafting output slot zero");
  var existing=ItemSelection.choose(List.of(2,9),-1,0).orElseThrow();
  check(existing.screenSlot()==38&&existing.hotbar()==2&&!existing.swap(),"an existing hotbar item is selected directly without rearranging other inventory");
  var explicit=ItemSelection.choose(List.of(0,9),5,0).orElseThrow();
  check(explicit.screenSlot()==36&&explicit.hotbar()==5&&explicit.swap(),"an explicit destination retains vanilla inventory/hotbar numbering");
  check(ItemSelection.choose(List.of(0,2),-1,2).orElseThrow().hotbar()==2,"the already selected matching item should remain stable");
  check(ItemSelection.choose(List.of(),-1,0).isEmpty(),"missing materials cannot be fabricated");
  boolean invalid=false;try{ItemSelection.choose(List.of(45),-1,0);}catch(IllegalArgumentException expected){invalid=true;}check(invalid,"armor/output slots are not main inventory item candidates");
  var empty=new ItemSelection.OutputSlot(9,true,true,false,0,64);
  var partial=new ItemSelection.OutputSlot(10,true,true,true,4,64);
  check(ItemSelection.output(List.of(empty,partial),4).orElseThrow()==10,"repeated four-plank recipe outputs must merge before consuming another empty slot");
  check(ItemSelection.output(List.of(new ItemSelection.OutputSlot(10,true,true,true,61,64),empty),4).orElseThrow()==9,"the entire output must fit before picking up one recipe batch");
  check(ItemSelection.output(List.of(new ItemSelection.OutputSlot(10,true,true,false,4,64),empty),4).orElseThrow()==9,"different item components cannot be merged");
  check(ItemSelection.output(List.of(new ItemSelection.OutputSlot(45,false,true,false,0,64)),4).isEmpty(),"offhand/armor/output slots do not count as acquired main-inventory output");
  check(ItemSelection.output(List.of(new ItemSelection.OutputSlot(10,true,false,true,4,64)),4).isEmpty(),"a slot rejecting insertion cannot receive output");
  check(ItemSelection.output(List.of(new ItemSelection.OutputSlot(10,true,true,true,15,16)),2).isEmpty(),"use the actual item and slot limit rather than assuming 64");
  check(ItemSelection.output(List.of(empty),0).isEmpty(),"an empty recipe preview is not extractable output");
  System.out.println("PASS semantic item preparation, real slot mapping and stable selection");
 }
}
