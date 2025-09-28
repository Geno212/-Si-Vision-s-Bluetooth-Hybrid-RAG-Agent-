// Debug script for R2 processing issues
// Usage: npx tsx debug-r2-processing.ts

const ENDPOINT = 'https://bt-rag.hybridrag.workers.dev'; // Your actual endpoint
// const ENDPOINT = 'http://127.0.0.1:8787'; // For local testing

async function debugR2Processing() {
  console.log('🔍 Debugging R2 Processing Issues...\n');
  
  // Test 1: Check if the endpoint is responding
  console.log('1. Testing basic endpoint health...');
  try {
    const response = await fetch(`${ENDPOINT}/`);
    console.log(`✅ Endpoint responding: ${response.status}`);
  } catch (error: any) {
    console.log(`❌ Endpoint not responding: ${error.message}`);
    return;
  }
  
  // Test 2: Check R2 processing with a simple text file
  console.log('\n2. Testing R2 processing with simple text...');
  
  const simpleTextFile = new File(['This is a simple test document for debugging R2 processing. It contains multiple sentences to ensure proper chunking works. The content is plain text so it should process without issues.'], 'test-debug.txt', {
    type: 'text/plain'
  });
  
  try {
    const formData = new FormData();
    formData.append('file', simpleTextFile);
    
    const uploadResponse = await fetch(`${ENDPOINT}/upload`, {
      method: 'POST',
      body: formData
    });
    
    if (!uploadResponse.ok) {
      console.log(`❌ Upload failed: ${uploadResponse.status} - ${await uploadResponse.text()}`);
      return;
    }
    
    const uploadResult = await uploadResponse.json();
    console.log(`✅ Upload successful: ${JSON.stringify(uploadResult)}`);
    
    // Now process it
    console.log('3. Processing uploaded file...');
    const processResponse = await fetch(`${ENDPOINT}/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filename: uploadResult.filename })
    });
    
    if (!processResponse.ok) {
      console.log(`❌ Processing failed: ${processResponse.status} - ${await processResponse.text()}`);
      return;
    }
    
    const processResult = await processResponse.json();
    console.log(`✅ Processing successful: ${JSON.stringify(processResult, null, 2)}`);
    
  } catch (error: any) {
    console.log(`❌ Test failed: ${error.message}`);
  }
  
  console.log('\n📋 Recommendations for your PDF:');
  console.log('1. Convert PDF to text file first');
  console.log('2. Or use "Extract text" feature in your PDF viewer');
  console.log('3. Upload the text version instead');
  console.log('4. Check worker logs with: wrangler tail');
}

// Alternative: Create a text-based test
async function testWithPlainText() {
  console.log('\n4. Testing with larger plain text document...');
  
  // Create a larger test document similar to what might be in your PDF
  const largeContent = `
Bluetooth Core Specification Version 6.1

1. Introduction
Bluetooth is a short-range wireless communication technology that enables devices to connect and exchange data over short distances. The Bluetooth Core Specification defines the technical requirements for Bluetooth devices and how they communicate.

2. Architecture Overview
The Bluetooth architecture consists of several layers:
- Radio Layer: Defines the physical characteristics of the Bluetooth radio
- Baseband Layer: Manages timing, frequency hopping, and access codes
- Link Manager Protocol (LMP): Handles connection establishment, configuration, and security
- L2CAP: Provides packet segmentation and reassembly, and multiplexing
- Application Protocols: Higher-level protocols for specific applications

3. Physical Layer Specifications
The Bluetooth radio operates in the 2.4 GHz ISM band (2.400-2.485 GHz). The system uses frequency hopping spread spectrum (FHSS) with up to 79 different frequency channels. Each channel is separated by 1 MHz.

4. Link Layer Protocol
The Link Layer manages the RF state of the device and handles packet transmission and reception. It implements five main states:
- Standby: The device is not actively participating in any connection
- Advertising: The device is broadcasting advertising packets
- Scanning: The device is listening for advertising packets
- Initiating: The device is attempting to create a connection
- Connected: The device is connected to another device

5. Security Features
Bluetooth implements several security mechanisms:
- Authentication: Verifies the identity of devices
- Authorization: Controls access to services and data
- Encryption: Protects data during transmission
- Key Management: Handles the generation and distribution of encryption keys

This document continues with detailed technical specifications...
`.repeat(10); // Make it larger to test chunking

  const textFile = new File([largeContent], 'bluetooth-spec.txt', {
    type: 'text/plain'
  });

  try {
    console.log(`📄 Testing with ${Math.round(largeContent.length / 1024)}KB text file...`);
    
    const formData = new FormData();
    formData.append('file', textFile);
    
    console.log('⏳ Uploading...');
    const uploadResponse = await fetch(`${ENDPOINT}/upload`, {
      method: 'POST',
      body: formData
    });
    
    if (!uploadResponse.ok) {
      console.log(`❌ Upload failed: ${uploadResponse.status}`);
      return;
    }
    
    const uploadResult = await uploadResponse.json();
    console.log(`✅ Upload successful, processing...`);
    
    const processResponse = await fetch(`${ENDPOINT}/process`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ filename: uploadResult.filename })
    });
    
    const processResult = await processResponse.json();
    
    if (processResponse.ok) {
      console.log(`✅ Large text processing successful!`);
      console.log(`📊 Stats: ${processResult.stats?.success_count || 0} chunks processed`);
    } else {
      console.log(`❌ Large text processing failed: ${processResponse.status}`);
      console.log(`Error: ${JSON.stringify(processResult, null, 2)}`);
    }
    
  } catch (error: any) {
    console.log(`❌ Large text test failed: ${error.message}`);
  }
}

// Main execution
async function main() {
  await debugR2Processing();
  await testWithPlainText();
  
  console.log('\n🎯 Summary:');
  console.log('- If text processing works but PDF fails, the issue is PDF text extraction');
  console.log('- Convert your PDF to text format for reliable processing');
  console.log('- Monitor logs with: wrangler tail --format=pretty');
  console.log('- Look for [R2_PROCESS] tags in the logs');
}

main().catch(console.error);



