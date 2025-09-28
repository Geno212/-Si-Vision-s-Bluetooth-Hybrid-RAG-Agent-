// Test script for improved document ingestion
// Usage: npx tsx test-improved-ingestion.ts

import { readFile } from 'fs/promises';
import path from 'path';

const ENDPOINT = 'http://127.0.0.1:8787'; // or your deployed endpoint
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN || 'test-token';

interface TestDocument {
  id: string;
  text: string;
  title: string;
  source: string;
}

// Create a large test document
function createLargeTestDocument(): TestDocument {
  const sections = [
    "# Bluetooth Low Energy (BLE) Protocol Overview",
    "Bluetooth Low Energy is a wireless personal area network technology designed and marketed by the Bluetooth Special Interest Group.",
    
    "## Core Architecture",
    "BLE operates in the 2.4 GHz ISM band, using a spread-spectrum, frequency hopping, full-duplex signal. The protocol stack consists of multiple layers including the Physical Layer, Link Layer, Host Controller Interface (HCI), Logical Link Control and Adaptation Protocol (L2CAP), Attribute Protocol (ATT), Generic Attribute Profile (GATT), and application layer.",
    
    "## Physical Layer Specifications",
    "The BLE physical layer operates in the 2.4 GHz band with 40 channels spaced 2 MHz apart. Three channels (37, 38, and 39) are used for advertising, while the remaining 37 channels are used for data transmission. The modulation scheme is Gaussian Frequency Shift Keying (GFSK) with a modulation index of 0.5.",
    
    "## Link Layer Protocol",
    "The Link Layer manages the RF state of the device and handles packet transmission and reception. It implements five states: Standby, Advertising, Scanning, Initiating, and Connection. The Link Layer also handles encryption, authentication, and error detection and correction.",
    
    "## Generic Attribute Profile (GATT)",
    "GATT defines the way that two BLE devices transfer data back and forth using concepts called Services and Characteristics. It uses the Attribute Protocol (ATT) as its transport protocol to store Services, Characteristics and related data in a simple lookup table using 16-bit IDs for each entry in the table.",
    
    "## Security Features",
    "BLE implements AES-128 encryption for security. The security architecture includes authentication, authorization, and encryption mechanisms. The protocol supports four security modes: Security Mode 1 (no security), Security Mode 2 (enforced security), Security Mode 3 (link-level enforced security), and Security Mode 4 (service-level enforced security).",
    
    "## Power Management",
    "One of the key features of BLE is its low power consumption. This is achieved through several mechanisms including short connection intervals, slave latency, supervision timeout, and the ability to remain in sleep mode for extended periods.",
    
    "## Advertising and Discovery",
    "BLE devices use advertising to make themselves discoverable. The advertising process involves broadcasting advertising packets on the three advertising channels. These packets contain information about the device and its available services.",
    
    "## Connection Establishment",
    "Connection establishment in BLE involves several steps including scanning, advertising, connection request, and connection establishment. The process is optimized for low power consumption while maintaining reliable connectivity.",
    
    "## Data Exchange Mechanisms",
    "Once connected, BLE devices can exchange data using various mechanisms including notifications, indications, read operations, and write operations. Each mechanism has different characteristics in terms of reliability and power consumption.",
    
    "## Error Handling and Reliability",
    "BLE implements various error handling mechanisms including cyclic redundancy check (CRC), automatic repeat request (ARQ), and forward error correction (FEC). These mechanisms ensure reliable data transmission in the presence of interference and noise."
  ];
  
  // Repeat content to create a larger document
  const repeatedContent = Array(50).fill(sections.join('\n\n')).join('\n\n');
  
  return {
    id: 'large-ble-test-doc',
    text: repeatedContent,
    title: 'Large BLE Protocol Documentation Test',
    source: 'test-improved-ingestion.ts'
  };
}

async function testIngestion(doc: TestDocument): Promise<void> {
  console.log('🧪 Testing improved ingestion with enhanced logging...');
  console.log(`📄 Document: ${doc.title}`);
  console.log(`📏 Size: ${doc.text.length} characters`);
  console.log(`🔗 Endpoint: ${ENDPOINT}/ingest-public`);
  
  const startTime = Date.now();
  
  try {
    const response = await fetch(`${ENDPOINT}/ingest-public`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(doc)
    });
    
    const result = await response.json();
    const duration = Date.now() - startTime;
    
    if (response.ok) {
      console.log('✅ Ingestion successful!');
      console.log(`⏱️  Duration: ${duration}ms`);
      console.log(`📊 Result:`, JSON.stringify(result, null, 2));
      
      // Test retrieval to verify ingestion worked
      console.log('\n🔍 Testing retrieval...');
      await testRetrieval();
      
    } else {
      console.error('❌ Ingestion failed!');
      console.error(`Status: ${response.status}`);
      console.error(`Error:`, result);
    }
    
  } catch (error: any) {
    console.error('❌ Request failed:', error.message);
  }
}

async function testRetrieval(): Promise<void> {
  try {
    const response = await fetch(`${ENDPOINT}/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question: 'What is Bluetooth Low Energy and how does it work?'
      })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      console.log('✅ Retrieval successful!');
      console.log('📖 Answer preview:', result.answer?.substring(0, 200) + '...');
      console.log('🔗 Sources found:', result.sources?.length || 0);
    } else {
      console.log('⚠️  Retrieval failed or no results found');
      console.log('Result:', result);
    }
    
  } catch (error: any) {
    console.error('❌ Retrieval test failed:', error.message);
  }
}

// Run the test
async function main() {
  console.log('🚀 Starting improved ingestion test...\n');
  
  const testDoc = createLargeTestDocument();
  await testIngestion(testDoc);
  
  console.log('\n✨ Test completed!');
  console.log('\n📋 Check the console logs from your worker for detailed ingestion logging:');
  console.log('   - [INGEST] tags for main ingestion process');
  console.log('   - [EMBEDDING] tags for batch embedding operations'); 
  console.log('   - [EMBEDDING_SINGLE] tags for individual embedding fallbacks');
  console.log('   - [PUBLIC_INGEST] tags for public endpoint operations');
}

main().catch(console.error);

