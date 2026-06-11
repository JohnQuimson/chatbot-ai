const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

// Inizializzazione del client Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
   console.error('❌ ERRORE: Configurazione Supabase mancante!');
   process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Funzione interna per leggere la whitelist
function caricaWhitelist() {
   try {
      const filePath = path.join(__dirname, 'whitelist.txt');
      if (!fs.existsSync(filePath)) {
         fs.writeFileSync(filePath, '', 'utf-8');
         return [];
      }
      const data = fs.readFileSync(filePath, 'utf-8');
      return data
         .split('\n')
         .map((line) => line.trim())
         .filter((line) => line.length > 0);
   } catch (error) {
      console.error('Errore lettura whitelist:', error.message);
      return [];
   }
}

// Configurazione CORS
app.use(
   cors({
      origin: function (origin, callback) {
         const whitelist = caricaWhitelist();
         if (!origin || whitelist.indexOf(origin) !== -1) {
            callback(null, true);
         } else {
            console.log(`🚫 Bloccato da CORS: ${origin}`);
            callback(new Error('Dominio non autorizzato.'));
         }
      },
   }),
);

async function ottieniEmbeddingDiretto(testo, apiKey) {
   // Uso l'endpoint v1 con il modello 'gemini-embedding-001'
   const url = `https://generativelanguage.googleapis.com/v1/models/gemini-embedding-001:embedContent?key=${apiKey}`;

   const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
         content: { parts: [{ text: testo }] },
      }),
   });

   const data = await response.json();

   if (!response.ok) {
      throw new Error(data.error?.message || `Errore HTTP: ${response.status}`);
   }

   if (!data.embedding?.values) {
      throw new Error('Risposta di embedding malformata da parte di Google.');
   }

   return data.embedding.values;
}

// =========================================================================
// ROTTA: Cancella Documentazione Vecchia
// =========================================================================
app.post('/cancella-documentazione', async (req, res) => {
   try {
      const { clienteId } = req.body;

      if (!clienteId) {
         return res.status(400).json({ successo: false, errore: 'ID Cliente mancante.' });
      }

      console.log(`🗑️ Eliminazione documentazione precedente per il cliente: ${clienteId}`);

      // Elimina tutte le righe che corrispondono al clienteId corrente
      const { error } = await supabase.from('documenti_clienti').delete().eq('cliente_id', clienteId);

      if (error) throw error;

      res.json({
         successo: true,
         messaggio: `Memoria precedente svuotata con successo per il cliente ${clienteId}.`,
      });
   } catch (error) {
      console.error('Errore durante la cancellazione:', error.message);
      res.status(500).json({ successo: false, errore: error.message });
   }
});

// =========================================================================
// ROTTA: Carica Documentazione (Chunking Strutturato basato su "===")
// =========================================================================
app.post('/carica-documentazione', async (req, res) => {
   try {
      const { clienteId, clienteKey, testoCompleto, sistemaPrompt } = req.body;

      if (!clienteId || !clienteKey || !testoCompleto) {
         return res.status(400).json({ errore: 'Dati mancanti.' });
      }

      // 1. CHUNKING STRUTTURATO: Dividiamo il testo usando le linee di "=" come delimitatori.
      // Cerca linee composte da 10 o più simboli "uguale" consecutivo (es. =======)
      const sezioni = testoCompleto.split(/={10,}/);

      const righeDaInserire = [];

      for (let sezione of sezioni) {
         // Pulizia preventiva da eventuali altri micro-separatori rimasti nel testo (es: --- o ___)
         let testoPulito = sezione
            .replace(/-{3,}/g, '')
            .replace(/\*{3,}/g, '')
            .replace(/_{3,}/g, '')
            .trim();

         // Saltiamo i blocchi vuoti o i soli residui di intestazione troppo corti
         if (testoPulito.length < 30) continue;

         // Generazione del vettore (embedding) per la macro-sezione intatta
         const embeddingVettoriale = await ottieniEmbeddingDiretto(testoPulito, clienteKey);

         righeDaInserire.push({
            cliente_id: clienteId,
            contenuto: testoPulito, // Mantiene intatti gli invii a capo originali (\n)
            embedding: embeddingVettoriale,
            sistema_prompt: sistemaPrompt || null,
         });
      }

      // 2. Salvataggio incrementale su Supabase
      if (righeDaInserire.length > 0) {
         const { error } = await supabase.from('documenti_clienti').insert(righeDaInserire);
         if (error) throw error;
      }

      res.json({
         successo: true,
         messaggio: `Documentazione sincronizzata. Generati ${righeDaInserire.length} blocchi logici basati sulle tue sezioni.`,
      });
   } catch (error) {
      console.error('Errore caricamento documentazione:', error.message);
      res.status(500).json({ errore: error.message });
   }
});

// =========================================================================
// ROTTA CHAT: Risposta STANDARD (No Streaming) con Gemini 2.5 Flash
// =========================================================================
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio, clienteKey, clienteId, cronologia } = req.body;

      if (!clienteKey || !clienteId || !messaggio) {
         return res.status(400).json({ errore: 'Dati in ingresso mancanti.' });
      }

      // 1. Preleviamo il prompt di sistema di questo cliente
      const { data: righeCliente, error: promptError } = await supabase
         .from('documenti_clienti')
         .select('sistema_prompt')
         .eq('cliente_id', clienteId)
         .not('sistema_prompt', 'is', null)
         .filter('sistema_prompt', 'neq', '')
         .limit(1);

      if (promptError) console.error('[REGISTRO] Errore recupero prompt:', promptError.message);

      const basePrompt =
         righeCliente && righeCliente.length > 0 && righeCliente[0].sistema_prompt
            ? righeCliente[0].sistema_prompt
            : 'Sei un assistente IA ufficiale del sito. Professionale ed educato.';

      // 2. RICERCA SEMANTICA (Embedding della sola domanda corrente)
      const queryEmbedding = await ottieniEmbeddingDiretto(messaggio, clienteKey);

      const { data: documentiTrovati, error: dbError } = await supabase.rpc('cerca_documenti', {
         query_embedding: queryEmbedding,
         match_threshold: 0.0,
         match_count: 4,
         filtro_cliente: clienteId,
      });

      if (dbError) throw dbError;

      const contestoRistretto =
         documentiTrovati && documentiTrovati.length > 0
            ? documentiTrovati.map((doc) => doc.contenuto).join('\n\n')
            : 'Nessuna informazione specifica trovata nella documentazione.';

      const istruzioniSistemaDinamiche = `${basePrompt}\n\nCONTESTO AZIENDALE DI RIFERIMENTO:\n${contestoRistretto}`;

      // 3. COSTRUZIONE DELLA CRONOLOGIA
      let contents = [];
      contents.push({
         role: 'user',
         parts: [{ text: `ISTRUZIONI DI SISTEMA:\n${istruzioniSistemaDinamiche}\n\nConferma di aver letto.` }],
      });
      contents.push({
         role: 'model',
         parts: [{ text: 'Ho letto le istruzioni. Risponderò in modo sintetico basandomi sul contesto.' }],
      });

      if (cronologia && Array.isArray(cronologia) && cronologia.length > 0) {
         const ultimeInterazioni = cronologia.slice(-6);
         ultimeInterazioni.forEach((item) => {
            contents.push({
               role: item.ruolo === 'utente' ? 'user' : 'model',
               parts: [{ text: item.testo }],
            });
         });
      }

      contents.push({
         role: 'user',
         parts: [{ text: messaggio }],
      });

      // 4. INIZIALIZZAZIONE MODELLO E GENERAZIONE RISPOSTA (Standard v1)
      const genAI = new GoogleGenerativeAI(clienteKey);
      const model = genAI.getGenerativeModel(
         {
            model: 'gemini-2.5-flash-lite',
            generationConfig: { temperature: 0.4 },
         },
         { apiVersion: 'v1' },
      );

      // Chiamata standard senza stream
      const result = await model.generateContent({
         contents: contents,
      });

      const rispostaTesto = result.response.text();

      // Rispondiamo con un normalissimo oggetto JSON
      return res.json({ successo: true, testo: rispostaTesto });
   } catch (error) {
      console.error('❌ Errore nella chat standard:', error.message);
      let messaggioUtente = "Si è verificato un problema di connessione con l'assistente.";
      if (error.message.includes('503') || error.message.includes('high demand')) {
         messaggioUtente = 'I server sono momentaneamente sovraccarichi. Riprova tra un istante.';
      }
      return res.status(500).json({ errore: messaggioUtente });
   }
});

app.get('/', (req, res) => {
   res.send('🚀 Gateway RAG multi-cliente stabile e attivo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`🚀 Server RAG pronto sulla porta ${PORT}`);
});
