package dev.momo.task;
public final class PlacementEvidence {
 public static boolean matches(String requestedItem,String actualBlockItem,boolean air,long sequence,long sentBoundary){
  return !air&&sequence>sentBoundary&&requestedItem.equals(actualBlockItem);
 }
 static boolean bedParts(BlockReceipts.Receipt foot,BlockReceipts.Receipt head,long sentBoundary){
  return foot!=null&&head!=null&&foot.seq()>sentBoundary&&head.seq()>sentBoundary
   &&foot.block().equals(head.block())&&foot.state().contains("part=foot")&&head.state().contains("part=head");
 }
}
