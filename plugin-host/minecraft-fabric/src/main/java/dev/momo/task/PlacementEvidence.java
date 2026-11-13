package dev.momo.task;
public final class PlacementEvidence {
 public static boolean matches(String requestedItem,String actualBlockItem,boolean air,long sequence,long sentBoundary){
  return !air&&sequence>sentBoundary&&requestedItem.equals(actualBlockItem);
 }
}
