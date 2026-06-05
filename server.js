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

// =========================================================================
// FUNZIONE DI SUPPORTO: Chiamata HTTP diretta senza bug di SDK
// =========================================================================
// =========================================================================
// FUNZIONE DI SUPPORTO: Chiamata HTTP diretta con il modello corretto
// =========================================================================
async function ottieniEmbeddingDiretto(testo, apiKey) {
   // Usiamo l'endpoint v1 con il modello ufficiale 'gemini-embedding-001'
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
// ROTTA: Carica Documentazione
// =========================================================================
app.post('/carica-documentazione', async (req, res) => {
   try {
      // Aggiungiamo "svuotaPrima" tra i dati ricevuti
      const { clienteId, clienteKey, testoCompleto, svuotaPrima } = req.body;

      if (!clienteId || !clienteKey || !testoCompleto) {
         return res.status(400).json({ errore: 'Dati mancanti.' });
      }

      // 1. 🗑️ Cancella i vecchi dati SOLO se WordPress ci dice esplicitamente di farlo (cioè al primo blocco)
      if (svuotaPrima === true) {
         const { error: deleteError } = await supabase.from('documenti_clienti').delete().eq('cliente_id', clienteId);

         if (deleteError) throw deleteError;
         console.log(`[INFO] Memoria svuotata per il cliente: ${clienteId}`);
      }

      const testoFiltrato = testoCompleto
         .replace(/={3,}/g, '') // Rimuove ===
         .replace(/-{3,}/g, '') // Rimuove ---
         .replace(/\*{3,}/g, '') // Rimuove ***
         .replace(/_{3,}/g, '') // Rimuove ___
         .replace(/\s+/g, ' '); // Compatta gli spazi bianchi risultanti

      // 2. ✂️ CHUNKING: Dividiamo il testo ricevuto in blocchi da 800 caratteri
      const chunk_size = 800;
      const regex = new RegExp(`.{1,${chunk_size}}(\\s|$)|.{1,${chunk_size}}`, 'g');
      const chunks = testoFiltrato.match(regex) || []; // <--- AGGIUNTO: Ora chunks è definito!

      // 3. 📦 Inizializziamo l'array che conterrà le righe da salvare
      const righeDaInserire = []; // <--- AGGIUNTO: Ora righeDaInserire è definito!

      // 4. Generiamo i vettori con la chiamata diretta v1
      for (const chunk of chunks) {
         const testoPulito = chunk.trim();
         if (testoPulito.length === 0) continue;

         const embeddingVettoriale = await ottieniEmbeddingDiretto(testoPulito, clienteKey);

         righeDaInserire.push({
            cliente_id: clienteId,
            contenuto: testoPulito,
            embedding: embeddingVettoriale,
         });
      }

      // 5. Salva su Supabase (eseguiamo l'insert solo se ci sono effettivamente righe)
      if (righeDaInserire.length > 0) {
         const { error } = await supabase.from('documenti_clienti').insert(righeDaInserire);
         if (error) throw error;
      }

      res.json({
         successo: true,
         messaggio: `Documentazione sincronizzata. Generati ${righeDaInserire.length} blocchi.`,
      });
   } catch (error) {
      console.error('Errore caricamento documentazione:', error.message);
      res.status(500).json({ errore: error.message });
   }
});

// =========================================================================
// ROTTA CHAT: Risposta con Gemini 2.5 Flash
// =========================================================================
app.post('/chiedi', async (req, res) => {
   try {
      const { messaggio, clienteKey, clienteId } = req.body;

      if (!clienteKey || !clienteId || !messaggio) {
         return res.status(400).json({ errore: 'Dati in ingresso mancanti.' });
      }

      // Vettorizziamo la domanda con la chiamata diretta v1
      const queryEmbedding = await ottieniEmbeddingDiretto(messaggio, clienteKey);

      // Cerchiamo il contesto su Supabase
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

      // Per la generazione del testo usiamo l'SDK con Gemini 2.5 Flash (che funziona benissimo)
      const genAI = new GoogleGenerativeAI(clienteKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

      const prompt = `Sei l'assistente IA ufficiale del sito. 
Rispondi in modo professionale basandoti esclusivamente sulle informazioni fornite qui sotto. 
Se la risposta non è presente nei dati, consiglia gentilmente di contattare l'assistenza umana.

INFORMAZIONI DI RIFERIMENTO PERTINENTI:
${contestoRistretto}

DOMANDA UTENTE:
${messaggio}`;

      const result = await model.generateContent(prompt);
      const response = await result.response;

      res.json({ risposta: response.text() });
   } catch (error) {
      console.error('Errore richiesta chat:', error.message);
      res.status(500).json({ errore: error.message });
   }
});

app.get('/', (req, res) => {
   res.send('🚀 Gateway RAG multi-cliente stabile e attivo.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
   console.log(`🚀 Server RAG pronto sulla porta ${PORT}`);
});
