package dev.momo.task;
public final class InventoryEvidenceSmoke {
 public static void main(String[] args){
  InventoryEvidence proof=new InventoryEvidence(0,7);proof.mutated(10,8);
  if(proof.settled(11,4,true,8))throw new AssertionError("client prediction is not server proof");
  if(proof.settled(20,4,true,8))throw new AssertionError("elapsed time alone is not acknowledgement");
  if(proof.settled(20,4,true,8))throw new AssertionError("a receipt before the latest mutation cannot prove that mutation");
  if(proof.settled(20,4,false,9))throw new AssertionError("cursor output is not in the inventory");
  if(!proof.settled(20,4,true,9))throw new AssertionError("settled server-confirmed gain should succeed");
  InventoryEvidence wrapped=new InventoryEvidence(0,32767);wrapped.mutated(1,32767);
  if(!wrapped.settled(5,4,true,0))throw new AssertionError("vanilla wrapping revision still acknowledges the mutation");
  System.out.println("PASS actual inventory settlement, not predicted click acknowledgement");
 }
}
